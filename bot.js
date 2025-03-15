/**
 * SimpleRLBot - Reinforcement Learning Bot for cutting trees in Minecraft
 */

const mineflayer = require('mineflayer');
const QAgent = require('./qlearning');
const BotActions = require('./actions');

class SimpleRLBot {
  constructor(options = {}) {
    this.options = {
      host: options.host || 'localhost',
      port: options.port || 25565,
      username: options.username || `RL_Bot_${Math.floor(Math.random() * 1000)}`,
      ...options
    };
    
    // Initialize properties
    this.bot = null;
    this.mcData = null;
    this.currentStep = 0;
    this.logs_collected = 0;
    this.last_inventory_count = 0;
    this.total_reward = 0;
    
    // Initialize RL agent
    this.agent = new QAgent({
      epsilon: options.epsilon || 0.2,
      learning_rate: options.learning_rate || 0.1,
      discount_factor: options.discount_factor || 0.9,
      actions_count: 5  // 5 possible actions
    });
    
    // Actions will be initialized after bot connects
    this.actions = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log(`Connecting to ${this.options.host}:${this.options.port} as ${this.options.username}`);
      this.bot = mineflayer.createBot(this.options);
      
      this.bot.once('spawn', () => {
        this.mcData = require('minecraft-data')(this.bot.version);
        console.log(`Bot spawned! Minecraft version: ${this.bot.version}`);
        
        // Initialize actions with bot instance
        this.actions = new BotActions(this.bot);
        this.actions.setMcData(this.mcData);
        
        this.last_inventory_count = this.actions.countLogsInInventory();
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

  // Get current state observation
  getObservation() {
    if (!this.bot || !this.actions) return null;
    
    const pos = this.bot.entity.position;
    
    // Find nearby tree logs
    const nearbyLogs = this.actions.findNearbyBlocks('log', 10);
    const closestLog = this.actions.findClosestBlock(nearbyLogs);
    
    return {
      position: {x: pos.x, y: pos.y, z: pos.z},
      yaw: this.bot.entity.yaw,
      pitch: this.bot.entity.pitch,
      inventory_logs: this.actions.countLogsInInventory(),
      tree_visible: nearbyLogs.length > 0,
      closest_log: closestLog ? {
        x: closestLog.position.x, 
        y: closestLog.position.y, 
        z: closestLog.position.z,
        distance: this.actions.distanceTo(closestLog.position)
      } : null
    };
  }

  // Execute action and get reward
// In bot.js, modify the executeAction method
  async executeAction(actionIdx) {
    let actionSuccess = false;
    const actionFunctions = [
      () => this.actions.moveForward(),    // 0: Move forward
      () => this.actions.turnLeft(),       // 1: Turn left
      () => this.actions.turnRight(),      // 2: Turn right 
      () => this.actions.jumpUp(),         // 3: Jump
      async () => {                        // 4: Break block in front
        // Return true/false directly from breakBlock
        return await this.actions.breakBlock();
      }
    ];
    
    if (actionIdx >= 0 && actionIdx < actionFunctions.length) {
      // Store the result of the action (especially important for BREAK)
      actionSuccess = await actionFunctions[actionIdx]();
    } else {
      console.warn(`Invalid action index: ${actionIdx}`);
    }
    
    // Direct reward for breaking blocks
    let reward = 0;
    
    // Give positive reward when breaking blocks successfully
    if (actionIdx === 4 && actionSuccess === true) {
      reward = 1.0; // Direct reward for breaking a block
    }
    
    // Small negative reward for each step to encourage efficiency
    const step_penalty = -0.01;
    
    const total_reward = reward + step_penalty;
    this.total_reward += total_reward;
    
    return total_reward;
  }

  // Choose an action based on current state
  chooseAction(state) {
    return this.agent.chooseAction(state);
  }
  
  // Update Q-values after taking an action
  updateQValues(state, action, reward, nextState) {
    const stateKey = this.agent.getStateKey(state);
    const nextStateKey = this.agent.getStateKey(nextState);
    this.agent.updateQTable(stateKey, action, reward, nextStateKey);
  }
  
  // Get current Q-table
  getQTable() {
    return this.agent.getQTable();
  }
  
  // Reduce exploration rate
  decayEpsilon() {
    return this.agent.decayEpsilon();
  }

  // Reset the environment for a new episode
  async reset() {
    if (!this.bot) {
      await this.connect();
    }
    
    this.currentStep = 0;
    this.total_reward = 0;
    this.last_inventory_count = this.actions.countLogsInInventory();
    
    // Look for trees on reset
    this.actions.findAndFaceNearestTree();
    
    return this.getObservation();
  }
}

module.exports = SimpleRLBot;