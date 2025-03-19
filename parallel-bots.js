const SimpleRLBot = require('./bot');

// Parse command line arguments for server IP and port - no defaults
function parseArgs() {
  const args = process.argv.slice(2);
  let serverIp = null;
  let serverPort = null;
  
  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ip' && i + 1 < args.length) {
      serverIp = args[i + 1];
      i++;
    } else if (args[i] === '--port' && i + 1 < args.length) {
      serverPort = parseInt(args[i + 1], 10);
      i++;
    }
  }
  
  // Validate required arguments
  if (!serverIp) {
    console.error("ERROR: Missing required parameter --ip");
    console.error("Usage: node parallel-bots.js --ip <SERVER_IP> --port <PORT>");
    process.exit(1);
  }
  
  if (!serverPort) {
    console.error("ERROR: Missing required parameter --port");
    console.error("Usage: node parallel-bots.js --ip <SERVER_IP> --port <PORT>");
    process.exit(1);
  }
  
  return { serverIp, serverPort };
}

class ParallelBotTraining {
  constructor(config) {
    this.config = config;
    this.bots = [];
    this.episodeRewards = [];
  }

  // Initialize bots with connection check
  async initializeBots() {
    console.log(`\nInitializing ${this.config.botCount} bots...`);
    
    // Create bots without connecting
    for (let i = 0; i < this.config.botCount; i++) {
      const botOptions = {
        ...this.config.botOptions,
        username: `${this.config.botOptions.username}_${i + 1}`,
        epsilon: this.config.botOptions.epsilon,
        learning_rate: this.config.botOptions.learning_rate,
        discount_factor: this.config.botOptions.discount_factor
      };
      
      console.log(`Creating bot ${i + 1}: ${botOptions.username}`);
      const bot = new SimpleRLBot(botOptions);
      this.bots.push(bot);
      this.episodeRewards[i] = [];
    }
    
    // Connect bots with connection check
    let connectionSuccessful = false;
    
    for (let i = 0; i < this.bots.length; i++) {
      console.log(`Connecting bot ${i + 1}: ${this.bots[i].options.username}`);
      try {
        await this.bots[i].connect();
        await new Promise(resolve => setTimeout(resolve, 150));
        console.log(`Bot ${i + 1} connected successfully!`);
        connectionSuccessful = true;
      } catch (error) {
        console.error(`Failed to connect bot ${i + 1}: ${error.message}`);
      }
    }
    
    // Exit if no bots connected successfully
    if (!connectionSuccessful) {
      console.error("\nERROR: No bots were able to connect to the server.");
      console.error(`Server: ${this.config.botOptions.host}:${this.config.botOptions.port}`);
      console.error("Please check that:");
      console.error("  1. The Minecraft server is running and open to LAN");
      console.error("  2. The IP address and port are correct");
      console.error("  3. There are no firewall issues blocking the connection");
      process.exit(1);
    }
    
    console.log(`Connected ${this.bots.filter(b => b.bot).length} out of ${this.bots.length} bots`);
  }
  
  async trainAllBots() {
    console.log('\n' + '═'.repeat(60));
    console.log('PARALLEL BOT MINECRAFT TREE CUTTING RL TRAINING');
    console.log('═'.repeat(60) + '\n');
    console.log(`Server: ${this.config.botOptions.host}:${this.config.botOptions.port}`);
    
    try {
      // Initialize bots
      if (this.bots.length === 0) {
        await this.initializeBots();
      }
      
      const episodes = this.config.episodes;
      const maxStepsPerEpisode = this.config.maxStepsPerEpisode;
      
      // Run episodes
      for (let episode = 0; episode < episodes; episode++) {
        console.log(`\n=========== EPISODE ${episode + 1}/${episodes} ===========`);
        
        console.log(`\nResetting all bots...`);
        
        const botStates = [];
        const botTotalRewards = Array(this.bots.length).fill(0);
        const botStartLogs = [];
        const botEpisodeStartTimes = Array(this.bots.length).fill(Date.now());
        
        // Reset each bot 
        for (let i = 0; i < this.bots.length; i++) {
          try {
            botStates[i] = await this.bots[i].reset();
            botStartLogs[i] = this.bots[i].last_inventory_count;
          } catch (error) {
            console.error(`Error resetting bot ${i + 1}: ${error.message}`);
            // Provide a default state if reset fails
            botStates[i] = null;
            botStartLogs[i] = 0;
          }
        }
        
        // Check if any bots have valid states
        const validBots = botStates.filter(state => state !== null).length;
        if (validBots === 0) {
          console.error("ERROR: No bots could be reset. Terminating training.");
          process.exit(1);
        }
        
        // Run steps 
        for (let step = 0; step < maxStepsPerEpisode; step++) {
          console.log(`\n----- STEP ${step + 1}/${maxStepsPerEpisode} -----`);
          
          // PHASE 1: All bots decide actions (no awaits here)
          const botActions = [];
          const stateKeys = [];
          
          for (let i = 0; i < this.bots.length; i++) {
            if (!botStates[i]) continue; // Skip bots that failed to reset
            
            const stateKey = this.bots[i].agent.getStateKey(botStates[i]);
            stateKeys[i] = stateKey;
            const action = this.bots[i].chooseAction(botStates[i]);
            botActions[i] = action;
          }
          
          // PHASE 2: All bots execute actions in parallel
          const actionPromises = this.bots.map((bot, index) => {
            if (!botStates[index]) return Promise.resolve(0); // Skip bots without state
            return bot.executeAction(botActions[index])
              .catch(error => {
                console.error(`Error executing action for bot ${index + 1}: ${error.message}`);
                return 0; // Return 0 reward on error
              });
          });
          
          // Wait for all actions to complete
          const rewards = await Promise.all(actionPromises);
          
          // PHASE 3: All bots observe new states and update
          const nextStates = [];
          
          for (let i = 0; i < this.bots.length; i++) {
            if (!botStates[i]) continue; // Skip bots without state
            
            botTotalRewards[i] += rewards[i];
            try {
              nextStates[i] = this.bots[i].getObservation();
              
              // Update Q-table
              this.bots[i].updateQValues(botStates[i], botActions[i], rewards[i], nextStates[i]);
              
              // Display step info
              this.displayStepInfo(
                i + 1,
                step + 1,
                stateKeys[i],
                botActions[i],
                rewards[i],
                nextStates[i]
              );
            } catch (error) {
              console.error(`Error updating bot ${i + 1}: ${error.message}`);
              nextStates[i] = botStates[i]; // Keep old state on error
            }
          }
          
          // Update states for next step
          for (let i = 0; i < this.bots.length; i++) {
            if (nextStates[i]) {
              botStates[i] = nextStates[i];
            }
          }
          
          // Small delay between steps to avoid overwhelming server
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Episode completed - summarize results
        console.log('\n' + '═'.repeat(60));
        console.log(`EPISODE ${episode + 1} COMPLETE`);
        console.log('═'.repeat(60));
        
        for (let i = 0; i < this.bots.length; i++) {
          if (!botStates[i]) continue; // Skip bots without state
          
          const bot = this.bots[i];
          const episodeDuration = (Date.now() - botEpisodeStartTimes[i]) / 1000;
          const logsCollected = bot.last_inventory_count - botStartLogs[i];
          this.episodeRewards[i].push(botTotalRewards[i]);
          
          // Decay exploration rate
          const newEpsilon = bot.decayEpsilon();
          
          // Show bot episode summary
          this.displayBotSummary(
            i + 1,
            episode + 1,
            botTotalRewards[i],
            logsCollected,
            newEpsilon,
            episodeDuration,
            bot
          );
        }
        
        // Knowledge sharing between bots (if enabled)
        if (this.config.shareKnowledge) {
          this.shareKnowledge();
        }
        
        // Show comparative results
        this.displayEpisodeComparison(episode + 1);
        
        // Break between episodes
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Training complete - show final results
      this.displayFinalResults();
      
    } catch (error) {
      console.error("Parallel bot training failed:", error);
      console.error(error.stack);
      process.exit(1);
    }
  }
  
  // Share knowledge between bots
  shareKnowledge() {
    if (this.bots.length <= 1) return;
    
    console.log("\nSharing knowledge between bots...");
    
    const mergedQTable = {};
    
    // Collect all states from all bots
    for (const bot of this.bots) {
      const qTable = bot.getQTable();
      for (const state in qTable) {
        if (!mergedQTable[state]) {
          mergedQTable[state] = Array(5).fill(0);
        }
        
        // Take the maximum Q-value for each action
        for (let action = 0; action < 5; action++) {
          mergedQTable[state][action] = Math.max(
            mergedQTable[state][action], 
            qTable[state][action]
          );
        }
      }
    }
    
    // Update all bots with the merged Q-table
    for (const bot of this.bots) {
      bot.agent.q_table = JSON.parse(JSON.stringify(mergedQTable));
    }
  }
  
  // Display methods
  displayStepInfo(botIndex, step, stateKey, action, reward, nextState) {
    const stateInfo = this.formatState(stateKey);
    const actionName = this.formatAction(action);
    const distance = nextState.closest_log ? nextState.closest_log.distance.toFixed(2) : 'N/A';
    
    console.log(
      `Bot ${botIndex} | ${stateInfo.visibility}/${stateInfo.distance}/${stateInfo.direction} | ` +
      `${actionName} | Reward: ${reward >= 0 ? '+' : ''}${reward.toFixed(2)} | ` +
      `Logs: ${nextState.inventory_logs} | Dist: ${distance}`
    );
  }
  
  displayBotSummary(botIndex, episode, totalReward, logsCollected, epsilon, duration, bot) {
    console.log(`\nBOT ${botIndex} (${bot.options.username}):`);
    console.log(`  Reward: ${totalReward.toFixed(2)} | Logs: ${logsCollected} | Time: ${duration.toFixed(1)}s`);
    console.log(`  Exploration: ${(epsilon * 100).toFixed(1)}% | States: ${Object.keys(bot.getQTable()).length}`);
    
    // Show top learned actions
    const qTable = bot.getQTable();
    const stateActionPairs = [];
    
    for (const state in qTable) {
      qTable[state].forEach((value, action) => {
        if (value > 0) {
          stateActionPairs.push({state, action, value});
        }
      });
    }
    
    if (stateActionPairs.length > 0) {
      stateActionPairs.sort((a, b) => b.value - a.value);
      const topPairs = stateActionPairs.slice(0, 2);
      
      console.log(`  Top learned actions:`);
      topPairs.forEach(pair => {
        const stateInfo = this.formatState(pair.state);
        console.log(
          `    When ${stateInfo.visibility}/${stateInfo.distance}/${stateInfo.direction}, ` +
          `${this.formatAction(pair.action)} (Q=${pair.value.toFixed(2)})`
        );
      });
    }
  }
  
  displayEpisodeComparison(episode) {
    console.log('\nPERFORMANCE COMPARISON:');
    
    for (let i = 0; i < this.bots.length; i++) {
      if (!this.episodeRewards[i] || this.episodeRewards[i].length === 0) continue;
      
      const rewards = this.episodeRewards[i];
      const lastReward = rewards[rewards.length - 1];
      const progressBar = this.createProgressBar(Math.max(0, lastReward), 10, 30);
      console.log(`  Bot ${i + 1}: ${lastReward.toFixed(2)} ${progressBar}`);
    }
  }
  
  displayFinalResults() {
    console.log('\n' + '═'.repeat(60));
    console.log('TRAINING COMPLETE!');
    console.log('═'.repeat(60));
    
    // Compare total rewards across episodes
    console.log('\nREWARD PROGRESSION BY BOT:');
    for (let botIndex = 0; botIndex < this.bots.length; botIndex++) {
      if (!this.episodeRewards[botIndex] || this.episodeRewards[botIndex].length === 0) continue;
      
      console.log(`\nBot ${botIndex + 1} (${this.bots[botIndex].options.username}):`);
      for (let ep = 0; ep < this.episodeRewards[botIndex].length; ep++) {
        const reward = this.episodeRewards[botIndex][ep];
        const bar = this.createProgressBar(Math.max(0, reward), 10, 30);
        console.log(`  Episode ${ep + 1}: ${reward.toFixed(2)} ${bar}`);
      }
    }
    
    // Compare final policies
    console.log('\nFINAL POLICIES:');
    for (let botIndex = 0; botIndex < this.bots.length; botIndex++) {
      console.log(`\nBot ${botIndex + 1} (${this.bots[botIndex].options.username}):`);
      
      const qTable = this.bots[botIndex].getQTable();
      const positiveStates = Object.keys(qTable).filter(state => 
        Math.max(...qTable[state]) > 0
      );
      
      if (positiveStates.length > 0) {
        for (const state of positiveStates) {
          const bestAction = qTable[state].indexOf(Math.max(...qTable[state]));
          const stateInfo = this.formatState(state);
          console.log(
            `  When logs are ${stateInfo.visibility}/${stateInfo.distance}/${stateInfo.direction}, ` +
            `${this.formatAction(bestAction)} is best`
          );
        }
      } else {
        console.log("  No significant learning yet");
      }
    }
  }
  
  // Helper methods
  formatAction(action) {
    const actions = ['MOVE', 'LEFT', 'RIGHT', 'JUMP', 'BREAK'];
    return actions[action] || 'UNKNOWN';
  }
  
  formatState(state) {
    const parts = state.split('_');
    if (parts.length >= 4) {
      return {
        visibility: parts[1],
        distance: parts[2],
        direction: parts[3]
      };
    }
    return { visibility: parts[1], distance: 'unknown', direction: 'unknown' };
  }
  
  createProgressBar(value, maxValue, size = 20) {
    const progress = Math.floor((value / maxValue) * size);
    return '[' + '='.repeat(progress) + ' '.repeat(size - progress) + ']';
  }
}

// Run parallel bot training with configurable params
async function runParallelBotTraining() {
  try {
    // Get server IP and port from command line args - required
    const { serverIp, serverPort } = parseArgs();
    
    const config = {
      botCount: 3,  // Up to 7 on a Singleplayer LAN world, but I can make a server if we need more
      botOptions: {
        host: serverIp,
        port: serverPort,
        username: 'Bot',        // Will be appended with bot number
        epsilon: 0.2,
        learning_rate: 0.2,
        discount_factor: 0.5
      },
      episodes: 1000,               // Start with fewer episodes for testing
      maxStepsPerEpisode: 20,
      shareKnowledge: true
    };
    
    console.log(`Starting training with ${config.botCount} bots on ${serverIp}:${serverPort}`);
    
    const parallelBots = new ParallelBotTraining(config);
    await parallelBots.trainAllBots();
  } catch (error) {
    console.error("Training initialization failed:", error);
    process.exit(1);
  }
}

// Run the parallel bot training if this file is executed directly
if (require.main === module) {
  runParallelBotTraining();
}

module.exports = {
  ParallelBotTraining,
  parseArgs
};