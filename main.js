/**
 * Main execution file for the Minecraft tree-cutting RL bot
 * With improved visualization and logging
 */

const SimpleRLBot = require('./bot');

// Helper functions for output formatting
function formatAction(action) {
  const actions = ['MOVE', 'LEFT', 'RIGHT', 'JUMP', 'BREAK'];
  return actions[action] || 'UNKNOWN';
}

function formatState(state) {
  // Extract components from state key for better display
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

function createProgressBar(value, maxValue, size = 20) {
  const progress = Math.floor((value / maxValue) * size);
  return '[' + '='.repeat(progress) + ' '.repeat(size - progress) + ']';
}

// Display a single training step with improved formatting
function displayStep(step, maxSteps, stateKey, action, reward, logs, distance, qValues) {
  const stateInfo = formatState(stateKey);
  const progressBar = createProgressBar(step, maxSteps);
  
  console.log('\n' + '─'.repeat(60));
  console.log(`STEP ${step}/${maxSteps} ${progressBar}`);
  
  // Format state information
  console.log(`\nSTATE:`);
  console.log(`  Logs: ${stateInfo.visibility.toUpperCase()} | Distance: ${stateInfo.distance.toUpperCase()} | Direction: ${stateInfo.direction.toUpperCase()}`);
  
  // Format action information
  console.log(`\nACTION: ${formatAction(action)}`);
  
  // Format result information
  console.log(`\nRESULT:`);
  console.log(`  Reward: ${reward >= 0 ? '+' : ''}${reward.toFixed(2)}`);
  console.log(`  Total Logs: ${logs}`);
  if (distance !== null) {
    console.log(`  Nearest Log: ${distance.toFixed(2)} blocks away`);
  }
  
  // Format Q-values with highlighting for the chosen action
  if (qValues) {
    console.log(`\nQ-VALUES:`);
    const qValuesFormatted = qValues.map((v, i) => {
      const value = v.toFixed(2);
      if (i === action) {
        return `[${formatAction(i)}]: \x1b[33m${value}\x1b[0m`; // Highlight chosen action
      }
      return `[${formatAction(i)}]: ${value}`;
    });
    
    // Display in two rows for better readability
    console.log(`  ${qValuesFormatted.slice(0, 3).join('  ')}`);
    console.log(`  ${qValuesFormatted.slice(3).join('  ')}`);
  }
}

// Display episode summary
function displayEpisodeSummary(episode, totalEpisodes, totalReward, totalLogs, epsilon, duration, bot) {
  console.log('\n' + '═'.repeat(60));
  console.log(`EPISODE ${episode}/${totalEpisodes} COMPLETE`);
  console.log('═'.repeat(60));
  
  console.log(`\nPERFORMANCE:`);
  console.log(`  Total Reward: ${totalReward.toFixed(2)}`);
  console.log(`  Logs Collected: ${totalLogs}`);
  console.log(`  Duration: ${duration.toFixed(1)} seconds`);
  
  console.log(`\nLEARNING:`);
  console.log(`  Exploration Rate: ${(epsilon * 100).toFixed(1)}%`);
  console.log(`  States Discovered: ${Object.keys(bot.getQTable()).length}`);
  
  // Visual indicator of improvement
  const rewardBar = createProgressBar(Math.max(0, totalReward), 10, 40);
  console.log(`\nImprovement: ${rewardBar}`);
}

// Display compact Q-table
function displayQTable(qTable) {
  console.log('\nQ-TABLE HIGHLIGHTS:');
  console.log('─'.repeat(60));
  
  // Get top 5 most promising state-action pairs
  const stateActionPairs = [];
  for (const state in qTable) {
    qTable[state].forEach((value, action) => {
      stateActionPairs.push({state, action, value});
    });
  }
  
  // Sort by value and take top 5
  const topPairs = stateActionPairs
    .filter(pair => pair.value > 0)  // Only consider positive values
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  
  // Display in a structured way
  if (topPairs.length > 0) {
    console.log('Best state-action pairs:');
    topPairs.forEach((pair, index) => {
      const stateInfo = formatState(pair.state);
      console.log(`  ${index + 1}. When logs are ${stateInfo.visibility}/${stateInfo.distance}/${stateInfo.direction}, `
                + `${formatAction(pair.action)} is good (Q=${pair.value.toFixed(2)})`);
    });
  } else {
    console.log('No significant learning yet.');
  }
  
  console.log('─'.repeat(60));
}

// RL training loop with improved visualization
async function runRLTraining() {
  const rlBot = new SimpleRLBot({
    host: '192.168.0.231',  // Replace with your server IP
    port: 57641,            // Replace with your server port
    username: 'TreeCutterRL',
    epsilon: 0.2,           // Initial exploration rate
    learning_rate: 0.1,
    discount_factor: 0.9
  });
  
  try {
    const episodes = 5;  // Number of training episodes
    const maxStepsPerEpisode = 100;
    
    console.log('\n' + '═'.repeat(60));
    console.log('MINECRAFT TREE CUTTING RL TRAINING');
    console.log('═'.repeat(60) + '\n');
    
    let episodeRewards = [];
    
    for (let episode = 0; episode < episodes; episode++) {
      console.log(`\nStarting Episode ${episode + 1}/${episodes}...`);
      
      // Reset environment
      let state = await rlBot.reset();
      let totalReward = 0;
      let startLogs = rlBot.last_inventory_count;
      let episodeStartTime = Date.now();
      
      // Run episode
      for (let step = 0; step < maxStepsPerEpisode; step++) {
        // Get state key for Q-table
        const stateKey = rlBot.agent.getStateKey(state);
        
        // Choose action using epsilon-greedy policy
        const action = rlBot.chooseAction(state);
        
        // Execute action and get reward
        const reward = await rlBot.executeAction(action);
        totalReward += reward;
        
        // Get next state
        const nextState = rlBot.getObservation();
        const nextStateKey = rlBot.agent.getStateKey(nextState);
        
        // Update Q-table
        rlBot.updateQValues(state, action, reward, nextState);
        
        // Display step information
        const currentLogsCount = nextState.inventory_logs;
        const distance = nextState.closest_log ? nextState.closest_log.distance : null;
        const qTable = rlBot.getQTable();
        displayStep(
          step + 1, 
          maxStepsPerEpisode, 
          stateKey, 
          action, 
          reward, 
          currentLogsCount,
          distance,
          qTable[stateKey]
        );
        
        // Update state for next iteration
        state = nextState;
        
        // Short delay between actions (for UI responsiveness)
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      // Episode completed
      const episodeDuration = (Date.now() - episodeStartTime) / 1000;
      const logsCollected = rlBot.last_inventory_count - startLogs;
      episodeRewards.push(totalReward);
      
      // After each episode, decrease exploration rate
      const newEpsilon = rlBot.decayEpsilon();
      
      // Display episode summary
      displayEpisodeSummary(
        episode + 1, 
        episodes, 
        totalReward, 
        logsCollected,
        newEpsilon,
        episodeDuration,
        rlBot
      );
      
      // Display compact Q-table
      displayQTable(rlBot.getQTable());
    }
    
    // Training complete - show final results
    console.log('\n' + '═'.repeat(60));
    console.log('TRAINING COMPLETE!');
    console.log('═'.repeat(60));
    
    console.log('\nREWARD PROGRESSION:');
    for (let i = 0; i < episodeRewards.length; i++) {
      const rewardBar = createProgressBar(Math.max(0, episodeRewards[i]), 10, 40);
      console.log(`Episode ${i + 1}: ${episodeRewards[i].toFixed(2)} ${rewardBar}`);
    }
    
    console.log('\nFINAL Q-TABLE STATISTICS:');
    const qTable = rlBot.getQTable();
    const numStates = Object.keys(qTable).length;
    console.log(`  States Discovered: ${numStates}`);
    console.log(`  Total State-Action Pairs: ${numStates * 5}`);
    
    // Find the best policy
    console.log('\nBEST POLICY:');
    for (const state in qTable) {
      const bestAction = qTable[state].indexOf(Math.max(...qTable[state]));
      const stateInfo = formatState(state);
      if (Math.max(...qTable[state]) > 0) {
        console.log(`  When logs are ${stateInfo.visibility}/${stateInfo.distance}/${stateInfo.direction}, `
                  + `${formatAction(bestAction)} is best`);
      }
    }
    
  } catch (error) {
    console.error("Training failed:", error);
  }
}

// For testing a pre-trained bot (load Q-values from a file)
async function runPreTrainedBot() {
  // This function could be implemented to load Q-values from a file
  // and run the bot in evaluation mode (no exploration)
  console.log("Pre-trained bot execution would go here");
}

// Uncomment the function you want to run
runRLTraining();
// runPreTrainedBot();