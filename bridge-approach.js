// JavaScript side (Mineflayer bot)
const mineflayer = require('mineflayer');
const zmq = require('zeromq');
const { BotActions } = require('./actions');

// Initialize the bridge
class RLBridge {
  constructor(options = {}) {
    this.options = options;
    this.socket = new zmq.Reply();
    this.bot = null;
    this.actions = null;
    this.currentState = null;
    this.isConnected = false;
  }

  async init() {
    // Start ZeroMQ server
    await this.socket.bind(`tcp://127.0.0.1:${this.options.port || 5555}`);
    console.log(`ZeroMQ server bound to port ${this.options.port || 5555}`);
    
    // Initialize Minecraft bot
    this.bot = mineflayer.createBot(this.options.botOptions);
    this.actions = new BotActions(this.bot);
    
    // Wait for bot to spawn
    await new Promise(resolve => this.bot.once('spawn', resolve));
    
    // Set up bot event handlers
    this.setupEventHandlers();
    
    // Start main loop
    this.isConnected = true;
    this.mainLoop();
  }

  setupEventHandlers() {
    // Handle bot events relevant to RL
    this.bot.on('physicsTick', () => {
      // Update state on every physics tick
      this.currentState = this.getObservation();
    });
  }

  getObservation() {
    // Extract relevant state information
    const pos = this.bot.entity.position;
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

  async mainLoop() {
    while (this.isConnected) {
      try {
        // Wait for a request from Python
        const [message] = await this.socket.receive();
        const request = JSON.parse(message.toString());
        
        if (request.type === 'get_state') {
          // Return current state
          await this.socket.send(JSON.stringify({
            status: 'ok',
            state: this.currentState
          }));
        } 
        else if (request.type === 'take_action') {
          // Execute action and return result
          const actionIndex = request.action;
          const result = await this.executeAction(actionIndex);
          
          await this.socket.send(JSON.stringify({
            status: 'ok',
            reward: result.reward,
            next_state: this.currentState,
            done: result.done
          }));
        }
        else if (request.type === 'reset') {
          // Reset the environment
          await this.reset();
          await this.socket.send(JSON.stringify({
            status: 'ok',
            state: this.currentState
          }));
        }
        else {
          await this.socket.send(JSON.stringify({
            status: 'error',
            message: 'Unknown request type'
          }));
        }
      } catch (error) {
        console.error('Error in main loop:', error);
        if (this.isConnected) {
          try {
            await this.socket.send(JSON.stringify({
              status: 'error',
              message: error.message
            }));
          } catch (e) {
            console.error('Failed to send error response:', e);
          }
        }
      }
    }
  }

  async executeAction(actionIndex) {
    // Execute the action in Minecraft
    let reward = 0;
    let done = false;
    
    const actionFunctions = [
      async () => await this.actions.moveForward(),
      async () => await this.actions.turnLeft(),
      async () => await this.actions.turnRight(),
      async () => await this.actions.jumpUp(),
      async () => await this.actions.breakBlock()
    ];
    
    if (actionIndex >= 0 && actionIndex < actionFunctions.length) {
      const success = await actionFunctions[actionIndex]();
      
      // Calculate reward
      if (actionIndex === 4 && success === true) {
        reward = 1.0; // Direct reward for breaking a block
      }
      
      // Small negative reward for each step to encourage efficiency
      reward += -0.01;
    }
    
    return { reward, done };
  }

  async reset() {
    // Reset the environment state
    this.actions.findAndFaceNearestTree();
    this.currentState = this.getObservation();
  }

  async close() {
    this.isConnected = false;
    if (this.socket) {
      await this.socket.close();
    }
    if (this.bot) {
      this.bot.end();
    }
  }
}

// Usage example
async function main() {
  const bridge = new RLBridge({
    port: 5555,
    botOptions: {
      username: 'RLBot',
      host: 'localhost',
      port: 25565
    }
  });
  
  await bridge.init();
  
  // Handle SIGINT
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await bridge.close();
    process.exit(0);
  });
}

main().catch(console.error);
