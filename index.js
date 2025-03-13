const mineflayer = require('mineflayer');
const Vec3 = require('vec3').Vec3;

class SimpleRLBot {
  constructor(options = {}) {
    this.options = {
      host: options.host || 'localhost',
      port: options.port || 25565,
      username: options.username || `RL_Bot_${Math.floor(Math.random() * 1000)}`,
      ...options
    };
    
    this.bot = null;
    this.mcData = null;
    this.currentStep = 0;
    this.logs_collected = 0;
    this.last_inventory_count = 0;
    this.total_reward = 0;
    
    // RL parameters
    this.epsilon = 0.2;  // Exploration rate (20% random actions)
    this.learning_rate = 0.1;
    this.discount_factor = 0.9;
    this.q_table = {};  // Simple state-action value function
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log(`Connecting to ${this.options.host}:${this.options.port} as ${this.options.username}`);
      this.bot = mineflayer.createBot(this.options);
      
      this.bot.once('spawn', () => {
        this.mcData = require('minecraft-data')(this.bot.version);
        console.log(`Bot spawned! Minecraft version: ${this.bot.version}`);
        this.last_inventory_count = this.countLogsInInventory();
        resolve();
      });
      
      this.bot.on('error', (err) => {
        console.error('Bot error:', err);
        reject(err);
      });
      
      this.bot.on('kicked', (reason) => {
        console.error('Bot kicked:', reason);
        reject(new Error(`Bot kicked: ${reason}`));
      });
    });
  }

  // RL methods
  getStateKey(observation) {
    // Simplify state to make Q-learning feasible
    // We'll discretize distance to nearest log and position
    const hasLog = observation.tree_visible;
    let distanceBucket = 'none';
    
    if (hasLog && observation.closest_log) {
      const distance = observation.closest_log.distance;
      if (distance < 3) distanceBucket = 'close';
      else if (distance < 6) distanceBucket = 'medium';
      else distanceBucket = 'far';
    }
    
    return `log_${hasLog ? 'visible' : 'none'}_${distanceBucket}`;
  }
  
  // Choose action using epsilon-greedy policy
  chooseAction(state) {
    // With probability epsilon, choose a random action (exploration)
    if (Math.random() < this.epsilon) {
      return Math.floor(Math.random() * 5);
    }
    
    // Otherwise, choose the best action from our Q-table (exploitation)
    const stateKey = this.getStateKey(state);
    if (!this.q_table[stateKey]) {
      this.q_table[stateKey] = [0, 0, 0, 0, 0]; // Initialize Q-values for this state
    }
    
    // Find action with maximum Q-value
    return this.q_table[stateKey].indexOf(Math.max(...this.q_table[stateKey]));
  }
  
  // Update Q-table with new experience
  updateQTable(stateKey, action, reward, nextStateKey) {
    if (!this.q_table[stateKey]) {
      this.q_table[stateKey] = [0, 0, 0, 0, 0];
    }
    
    if (!this.q_table[nextStateKey]) {
      this.q_table[nextStateKey] = [0, 0, 0, 0, 0];
    }
    
    // Q-learning update: Q(s,a) = Q(s,a) + α [r + γ * max Q(s',a') - Q(s,a)]
    const oldValue = this.q_table[stateKey][action];
    const nextMax = Math.max(...this.q_table[nextStateKey]);
    
    // Update rule
    this.q_table[stateKey][action] = oldValue + this.learning_rate * 
      (reward + this.discount_factor * nextMax - oldValue);
  }

  // Simple observation function - returns a minimal state representation
  getObservation() {
    const pos = this.bot.entity.position;
    
    // Find nearby tree logs
    const nearbyLogs = this.findNearbyBlocks('log', 10);
    const closestLog = this.findClosestBlock(nearbyLogs);
    
    return {
      position: {x: pos.x, y: pos.y, z: pos.z},
      yaw: this.bot.entity.yaw,
      pitch: this.bot.entity.pitch,
      inventory_logs: this.countLogsInInventory(),
      tree_visible: nearbyLogs.length > 0,
      closest_log: closestLog ? {
        x: closestLog.position.x, 
        y: closestLog.position.y, 
        z: closestLog.position.z,
        distance: this.distanceTo(closestLog.position)
      } : null
    };
  }

  // Simple action function - takes an action index and executes it
  async executeAction(actionIdx) {
    const actions = [
      () => this.moveForward(),    // 0: Move forward
      () => this.turnLeft(),       // 1: Turn left
      () => this.turnRight(),      // 2: Turn right 
      () => this.jumpUp(),         // 3: Jump
      () => this.breakBlock()      // 4: Break block in front
    ];
    
    if (actionIdx >= 0 && actionIdx < actions.length) {
      await actions[actionIdx]();
    } else {
      console.warn(`Invalid action index: ${actionIdx}`);
    }
    
    // Calculate reward: +1 for each new log collected
    const current_count = this.countLogsInInventory();
    const reward = current_count - this.last_inventory_count;
    this.last_inventory_count = current_count;
    
    // Also give small negative reward for each step to encourage efficiency
    const step_penalty = -0.01;
    
    const total_reward = reward + step_penalty;
    this.total_reward += total_reward;
    
    return total_reward;
  }

  // Reset the environment
  async reset() {
    if (!this.bot) {
      await this.connect();
    }
    
    this.currentStep = 0;
    this.total_reward = 0;
    this.last_inventory_count = this.countLogsInInventory();
    
    // Look for trees on reset
    this.findAndFaceNearestTree();
    
    return this.getObservation();
  }

  // Helper Methods
  findNearbyBlocks(blockName, radius) {
    // Handle different Minecraft versions (oak_log vs log)
    let blockIds = [];
    
    // Try different variations of log names
    const possibleNames = [blockName, `oak_${blockName}`, 'log', 'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];
    
    for (const name of possibleNames) {
      if (this.mcData.blocksByName[name]) {
        blockIds.push(this.mcData.blocksByName[name].id);
      }
    }
    
    if (blockIds.length === 0) {
      console.warn(`Could not find block type: ${blockName}`);
      return [];
    }

    const positions = this.bot.findBlocks({
      matching: (block) => {
        // Check if block exists and has a name
        if (!block || !block.name) return false;
        
        // Check for log in name
        if (block.name.includes('log')) return true;
        
        // Check against our list of block IDs
        return blockIds.includes(block.type);
      },
      maxDistance: radius,
      count: 20
    });

    return positions.map(pos => {
      return {
        position: pos,
        block: this.bot.blockAt(pos)
      };
    });
  }

  findAndFaceNearestTree() {
    const nearbyLogs = this.findNearbyBlocks('log', 20);
    const closestLog = this.findClosestBlock(nearbyLogs);
    
    if (closestLog) {
      console.log(`Found nearest log at ${closestLog.position.x}, ${closestLog.position.y}, ${closestLog.position.z}`);
      this.bot.lookAt(closestLog.position);
      return true;
    }
    
    console.log("No trees found nearby");
    return false;
  }

  findClosestBlock(blocks) {
    if (!blocks || blocks.length === 0) return null;
    
    return blocks.reduce((closest, current) => {
      if (!closest) return current;
      
      const closestDist = this.distanceTo(closest.position);
      const currentDist = this.distanceTo(current.position);
      return currentDist < closestDist ? current : closest;
    }, null);
  }

  distanceTo(position) {
    return this.bot.entity.position.distanceTo(position);
  }

  countLogsInInventory() {
    if (!this.bot.inventory) return 0;
    
    return this.bot.inventory.items()
      .filter(item => item.name.includes('log'))
      .reduce((count, item) => count + item.count, 0);
  }

  // Basic actions
  async moveForward() {
    this.bot.setControlState('forward', true);
    await new Promise(resolve => setTimeout(resolve, 350));
    this.bot.setControlState('forward', false);
  }

  async turnLeft() {
    const yaw = this.bot.entity.yaw + (Math.PI/4); // 45 degrees
    await this.bot.look(yaw, this.bot.entity.pitch);
  }

  async turnRight() {
    const yaw = this.bot.entity.yaw - (Math.PI/4); // 45 degrees
    await this.bot.look(yaw, this.bot.entity.pitch);
  }

  async jumpUp() {
    this.bot.setControlState('jump', true);
    await new Promise(resolve => setTimeout(resolve, 350));
    this.bot.setControlState('jump', false);
  }

  // Improved break block function
  async breakBlock() {
    // Find nearby logs
    const nearbyLogs = this.findNearbyBlocks('log', 5);
    const closestLog = this.findClosestBlock(nearbyLogs);
    
    if (!closestLog) {
      console.log("No logs found nearby to break");
      return false;
    }
    
    // Look directly at the log
    const logPos = closestLog.position.clone();
    logPos.add(new Vec3(0.5, 0.5, 0.5)); // Aim at center of block
    await this.bot.lookAt(logPos);
    
    // Wait a moment for the bot to properly look at the block
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Get the block the bot is now looking at
    const blockInSight = this.bot.blockAtCursor(4);
    
    if (!blockInSight) {
      console.log("No block in sight after looking at log position");
      return false;
    }
    
    // Check if we're looking at a log
    if (blockInSight.name.includes('log')) {
      try {
        console.log(`Breaking ${blockInSight.name} at ${blockInSight.position.x}, ${blockInSight.position.y}, ${blockInSight.position.z}`);
        await this.bot.dig(blockInSight);
        console.log("Successfully broke log block!");
        return true;
      } catch (e) {
        console.log("Error breaking block:", e.message);
        return false;
      }
    } else {
      console.log(`Not breaking ${blockInSight.name} (not a log)`);
      return false;
    }
  }
}

// RL training loop
async function runRLTraining() {
  const rlBot = new SimpleRLBot({
    host: '192.168.0.231',  // Replace with your server IP
    port: 56612,            // Replace with your server port
    username: 'TreeCutterRL'
  });
  
  try {
    const episodes = 5;  // Number of training episodes
    const maxStepsPerEpisode = 100;
    
    for (let episode = 0; episode < episodes; episode++) {
      console.log(`\n--- Starting Episode ${episode + 1} ---`);
      
      // Reset environment
      let state = await rlBot.reset();
      let totalReward = 0;
      
      // Run episode
      for (let step = 0; step < maxStepsPerEpisode; step++) {
        // Get state key for Q-table
        const stateKey = rlBot.getStateKey(state);
        
        // Choose action using epsilon-greedy policy
        const action = rlBot.chooseAction(state);
        console.log(`\nStep ${step}, State: ${stateKey}, Action: ${action}`);
        
        // Execute action and get reward
        const reward = await rlBot.executeAction(action);
        totalReward += reward;
        
        // Get next state
        const nextState = rlBot.getObservation();
        const nextStateKey = rlBot.getStateKey(nextState);
        
        // Update Q-table
        rlBot.updateQTable(stateKey, action, reward, nextStateKey);
        
        // Log current state
        console.log(`Reward: ${reward.toFixed(2)}, Logs: ${nextState.inventory_logs}`);
        if (nextState.closest_log) {
          console.log(`Closest log at distance ${nextState.closest_log.distance.toFixed(2)}`);
        } else {
          console.log(`No logs visible`);
        }
        
        // Debug output of Q-values for current state
        if (rlBot.q_table[stateKey]) {
          console.log(`Q-values for state ${stateKey}:`, 
            rlBot.q_table[stateKey].map(v => v.toFixed(2)));
        }
        
        // Update state for next iteration
        state = nextState;
        
        // Short delay between actions
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      console.log(`\nEpisode ${episode + 1} completed. Total reward: ${totalReward.toFixed(2)}`);
      
      // After each episode, decrease exploration rate
      rlBot.epsilon = Math.max(0.05, rlBot.epsilon * 0.9);
      console.log(`New exploration rate (epsilon): ${rlBot.epsilon.toFixed(2)}`);
      
      // Display Q-table
      console.log("\nCurrent Q-table:");
      for (const state in rlBot.q_table) {
        console.log(`${state}: [${rlBot.q_table[state].map(v => v.toFixed(2)).join(', ')}]`);
      }
    }
    
    console.log("\nTraining complete!");
    
  } catch (error) {
    console.error("Training failed:", error);
  }
}

runRLTraining();