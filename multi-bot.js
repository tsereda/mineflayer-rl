/**
 * Multi-bot training for Minecraft tree-cutting RL
 * Allows multiple bots to train simultaneously or collaboratively
 */

const SimpleRLBot = require('./bot');

class MultiBotTraining {
  constructor(config) {
    this.config = config;
    this.bots = [];
    this.episodeRewards = [];
  }

  // Initialize all bots
  async initializeBots() {
    console.log(`\nInitializing ${this.config.botCount} bots...`);
    
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
      
      // Add a slight delay between bot connections to prevent server overload
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    console.log(`All ${this.bots.length} bots initialized`);
  }
  
  // Run training across all bots in parallel
  async trainAllBots() {
    console.log('\n' + '═'.repeat(60));
    console.log('MULTI-BOT MINECRAFT TREE CUTTING RL TRAINING');
    console.log('═'.repeat(60) + '\n');
    
    try {
      // Initialize bots if not already done
      if (this.bots.length === 0) {
        await this.initializeBots();
      }
      
      const episodes = this.config.episodes;
      const maxStepsPerEpisode = this.config.maxStepsPerEpisode;
      
      // Initialize all bot states and episode tracking variables
      let botStates = [];
      let botTotalRewards = [];
      let botStartLogs = [];
      let botEpisodeStartTimes = [];
      
      // Run episodes
      for (let episode = 0; episode < episodes; episode++) {
        console.log(`\n=========== EPISODE ${episode + 1}/${episodes} ===========`);
        
        // Reset all bots at the start of the episode
        for (let botIndex = 0; botIndex < this.bots.length; botIndex++) {
          const bot = this.bots[botIndex];
          console.log(`\n----- Resetting Bot ${botIndex + 1}: ${bot.options.username} -----`);
          
          // Reset environment for this bot
          botStates[botIndex] = await bot.reset();
          botTotalRewards[botIndex] = 0;
          botStartLogs[botIndex] = bot.last_inventory_count;
          botEpisodeStartTimes[botIndex] = Date.now();
        }
        
        // Now run steps with all bots acting in parallel
        for (let step = 0; step < maxStepsPerEpisode; step++) {
          console.log(`\n----- STEP ${step + 1}/${maxStepsPerEpisode} -----`);
          
          // For each step, let all bots take an action
          for (let botIndex = 0; botIndex < this.bots.length; botIndex++) {
            const bot = this.bots[botIndex];
            
            const stateKey = bot.agent.getStateKey(botStates[botIndex]);
            const action = bot.chooseAction(botStates[botIndex]);
            
            // Execute action and get reward
            const reward = await bot.executeAction(action);
            botTotalRewards[botIndex] += reward;
            
            // Get next state and update Q-table
            const nextState = bot.getObservation();
            bot.updateQValues(botStates[botIndex], action, reward, nextState);
            
            // Show compact step info (less verbose than single bot training)
            this.displayCompactStepInfo(
              botIndex + 1,
              step + 1,
              stateKey,
              action, 
              reward,
              nextState
            );
            
            // Update state for next iteration
            botStates[botIndex] = nextState;
            
            // Small delay between bot actions to prevent server overload
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          
          // Delay between steps
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Episode completed for all bots - summarize results
        for (let botIndex = 0; botIndex < this.bots.length; botIndex++) {
          const bot = this.bots[botIndex];
          const episodeDuration = (Date.now() - botEpisodeStartTimes[botIndex]) / 1000;
          const logsCollected = bot.last_inventory_count - botStartLogs[botIndex];
          this.episodeRewards[botIndex].push(botTotalRewards[botIndex]);
          
          // Decay exploration rate
          const newEpsilon = bot.decayEpsilon();
          
          // Show bot episode summary
          this.displayBotEpisodeSummary(
            botIndex + 1,
            episode + 1,
            botTotalRewards[botIndex],
            logsCollected,
            newEpsilon,
            episodeDuration,
            bot
          );
        }
        
        // Option: Share Q-tables between bots if knowledge sharing is enabled
        if (this.config.shareKnowledge) {
          this.shareKnowledge();
        }
        
        // After each full episode, show comparative results
        this.displayEpisodeComparison(episode + 1);
        
        // Give a break between episodes
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Training complete - show final results
      this.displayFinalResults();
      
    } catch (error) {
      console.error("Multi-bot training failed:", error);
    }
  }
  
  // Share knowledge (Q-tables) between bots
  shareKnowledge() {
    if (this.bots.length <= 1) return;
    
    console.log("\nSharing knowledge between bots...");
    
    // Simple approach: merge Q-tables by taking the maximum Q-value for each state-action pair
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
  displayCompactStepInfo(botIndex, step, stateKey, action, reward, nextState) {
    const stateInfo = this.formatState(stateKey);
    const actionName = this.formatAction(action);
    const distance = nextState.closest_log ? nextState.closest_log.distance.toFixed(2) : 'N/A';
    
    console.log(
      `Bot ${botIndex} | Step ${step.toString().padStart(3)} | ` +
      `${stateInfo.visibility}/${stateInfo.distance}/${stateInfo.direction} | ` +
      `${actionName} | Reward: ${reward >= 0 ? '+' : ''}${reward.toFixed(2)} | ` +
      `Logs: ${nextState.inventory_logs} | Distance: ${distance}`
    );
  }
  
  displayBotEpisodeSummary(botIndex, episode, totalReward, logsCollected, epsilon, duration, bot) {
    console.log('\n' + '─'.repeat(60));
    console.log(`BOT ${botIndex} EPISODE ${episode} SUMMARY:`);
    console.log(`  Reward: ${totalReward.toFixed(2)} | Logs: ${logsCollected} | Time: ${duration.toFixed(1)}s`);
    console.log(`  Exploration: ${(epsilon * 100).toFixed(1)}% | States: ${Object.keys(bot.getQTable()).length}`);
    
    // Show top 3 learned state-action pairs for this bot
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
      const topPairs = stateActionPairs.slice(0, 3);
      
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
    console.log('\n' + '═'.repeat(60));
    console.log(`EPISODE ${episode} COMPARISON`);
    console.log('═'.repeat(60));
    
    // Compare performance
    console.log('\nPerformance comparison:');
    for (let i = 0; i < this.bots.length; i++) {
      const rewards = this.episodeRewards[i];
      const lastReward = rewards[rewards.length - 1];
      const progressBar = this.createProgressBar(Math.max(0, lastReward), 10, 30);
      console.log(`  Bot ${i + 1}: ${lastReward.toFixed(2)} ${progressBar}`);
    }
    
    // Compare learning progress
    console.log('\nLearning progress:');
    for (let i = 0; i < this.bots.length; i++) {
      const statesCount = Object.keys(this.bots[i].getQTable()).length;
      console.log(`  Bot ${i + 1}: ${statesCount} states discovered`);
    }
  }
  
  displayFinalResults() {
    console.log('\n' + '═'.repeat(60));
    console.log('MULTI-BOT TRAINING COMPLETE!');
    console.log('═'.repeat(60));
    
    // Compare total rewards across episodes
    console.log('\nREWARD PROGRESSION BY BOT:');
    for (let botIndex = 0; botIndex < this.bots.length; botIndex++) {
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

// Example usage
async function runMultiBotTraining() {
  const config = {
    botCount: 3,
    botOptions: {
      host: '192.168.0.231',  // Replace with your server IP
      port: 57641,            // Replace with your server port
      username: 'TreeBot',    // Will be appended with bot number
      epsilon: 0.2,
      learning_rate: 0.1,
      discount_factor: 0.9
    },
    episodes: 3,
    maxStepsPerEpisode: 30,   // Shorter episodes for multiple bots
    shareKnowledge: true      // Whether bots should share their Q-tables
  };
  
  const multiBot = new MultiBotTraining(config);
  await multiBot.trainAllBots();
}

// Create a specialized training configuration
async function runSpecializedBotTraining() {
  // Each bot will have a different strategy
  const config = {
    botCount: 3,
    botOptions: {
      host: '192.168.0.231',  // Replace with your server IP
      port: 57641,            // Replace with your server port
      username: 'SpecBot',    // Will be appended with bot number
      epsilon: 0.2,
      learning_rate: 0.1,
      discount_factor: 0.9
    },
    episodes: 3,
    maxStepsPerEpisode: 30,
    shareKnowledge: false     // Independent learning
  };
  
  // Create bots with different parameters
  const multiBot = new MultiBotTraining(config);
  await multiBot.initializeBots();
  
  // Modify bot parameters for specialization:
  // Bot 1: Explorer (high exploration, learns slower)
  multiBot.bots[0].agent.epsilon = 0.4;
  multiBot.bots[0].agent.learning_rate = 0.05;
  
  // Bot 2: Balanced (default parameters)
  // Keep default parameters
  
  // Bot 3: Exploiter (low exploration, learns faster)
  multiBot.bots[2].agent.epsilon = 0.1;
  multiBot.bots[2].agent.learning_rate = 0.2;
  
  await multiBot.trainAllBots();
}

// Run multi-bot training
runMultiBotTraining();