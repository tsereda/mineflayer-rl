/**
 * RLBridgeServer - Serves as a bridge between Python RL agents and JavaScript Mineflayer bots
 * Uses ZeroMQ for communication with Python
 */
const mineflayer = require('mineflayer');
const zmq = require('zeromq');
const BotActions = require('./bot_actions');

class RLBridgeServer {
  constructor(options = {}) {
    this.serverOptions = {
      host: options.host || 'localhost',
      port: options.port || 25565,
      basePort: options.basePort || 5555,
      numBots: options.numBots || 6,
    };
    
    // Map to store bot instances: Map<botId, {socket, bot, actions, currentState, isConnected}>
    this.bots = new Map();
    this.shuttingDown = false;
  }

  async init() {
    console.log(`Initializing RL Bridge Server with ${this.serverOptions.numBots} bots...`);
    console.log(`Minecraft Server: ${this.serverOptions.host}:${this.serverOptions.port}`);
    
    // Start all bots
    const initPromises = [];
    for (let i = 0; i < this.serverOptions.numBots; i++) {
      const botId = `bot_${i}`;
      const zmqPort = this.serverOptions.basePort + i;
      
      initPromises.push(this.initializeBot(botId, zmqPort, i));
    }
    
    try {
      await Promise.all(initPromises);
      console.log(`Successfully initialized ${this.bots.size} out of ${this.serverOptions.numBots} bots`);
      
      if (this.bots.size === 0) {
        throw new Error("No bots could be initialized. Check Minecraft server connectivity.");
      }
    } catch (error) {
      console.error("Error during initialization:", error);
      await this.shutdown();
      throw error;
    }
  }

  async initializeBot(botId, zmqPort, index) {
    console.log(`Initializing ${botId} with ZMQ port ${zmqPort}...`);

    try {
      // Set up ZMQ Reply socket
      const socket = new zmq.Reply();
      const bindAddress = `tcp://127.0.0.1:${zmqPort}`;
      await socket.bind(bindAddress);
      console.log(`[${botId}] ZMQ socket bound to ${bindAddress}`);
      
      // Create Mineflayer bot with offset spawn position
      const botOptions = {
        host: this.serverOptions.host,
        port: this.serverOptions.port,
        username: `RLBot_${index}`,
        auth: 'offline',
        // Spread bots 2 blocks apart to avoid collision
        position: { x: index * 2, y: 0, z: index * 2 }
      };
      
      const bot = mineflayer.createBot(botOptions);
      
      // Wait for bot to spawn
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`[${botId}] Bot spawn timed out`)), 60000);
        
        bot.once('spawn', () => {
          clearTimeout(timeout);
          console.log(`[${botId}] Bot spawned successfully`);
          resolve();
        });
        
        bot.once('end', (reason) => {
          clearTimeout(timeout);
          reject(new Error(`[${botId}] Bot disconnected before spawning: ${reason}`));
        });
        
        bot.once('error', (err) => {
          clearTimeout(timeout);
          reject(new Error(`[${botId}] Bot connection error: ${err.message}`));
        });
      });
      
      // Attach mcData manually
      const minecraftData = require('minecraft-data');
      if (bot.version) {
        bot.mcData = minecraftData(bot.version);
        console.log(`[${botId}] Attached mcData for version ${bot.version}`);
      } else {
        throw new Error(`[${botId}] Failed to determine Minecraft version`);
      }
      
      // Set up the actions class
      const actions = new BotActions(bot);
      
      // Register the bot in our map
      this.bots.set(botId, {
        socket,
        bot,
        actions,
        currentState: null,
        isConnected: true
      });
      
      // Set up event handlers for this bot
      this.setupBotEventHandlers(botId);
      
      // Start the message loop for this bot
      this.startMessageLoop(botId);
      
      return true;
    } catch (error) {
      console.error(`[${botId}] Initialization failed:`, error.message);
      
      // Cleanup if bot was partially initialized
      if (this.bots.has(botId)) {
        const botData = this.bots.get(botId);
        
        // Close socket if initialized
        if (botData.socket && !botData.socket.closed) {
          await botData.socket.close().catch(e => console.error(`[${botId}] Error closing socket:`, e));
        }
        
        // Disconnect bot if initialized
        if (botData.bot) {
          botData.bot.end(`[${botId}] Cleanup after initialization error`);
        }
        
        // Remove from map
        this.bots.delete(botId);
      }
      
      throw error;
    }
  }

  setupBotEventHandlers(botId) {
    const botData = this.bots.get(botId);
    if (!botData) return;
    
    const { bot, actions } = botData;
    
    // Update state on physics tick
    bot.on('physicsTick', () => {
      if (bot && bot.entity && actions && bot.mcData) {
        try {
          botData.currentState = this.getObservation(botId);
        } catch (error) {
          console.error(`[${botId}] Error updating state:`, error.message);
        }
      }
    });
    
    // Handle errors
    bot.on('error', (err) => {
      console.error(`[${botId}] Bot error:`, err.message);
    });
    
    // Handle disconnects/kicks
    bot.on('end', (reason) => {
      console.log(`[${botId}] Bot disconnected: ${reason}`);
      botData.isConnected = false;
      
      // Clean up if not in shutdown process
      if (!this.shuttingDown) {
        this.cleanupBot(botId).catch(e => 
          console.error(`[${botId}] Error during cleanup:`, e)
        );
      }
    });
    
    bot.on('kicked', (reason) => {
      console.error(`[${botId}] Bot kicked: ${reason}`);
      botData.isConnected = false;
    });
  }

  getObservation(botId) {
    const botData = this.bots.get(botId);
    if (!botData) return null;
    
    const { bot, actions } = botData;
    
    // Safety check
    if (!bot || !bot.entity || !actions || !bot.mcData) {
      return null;
    }
    
    try {
      const pos = bot.entity.position;
      const nearbyLogs = actions.findNearbyBlocks('log', 10);
      const closestLog = actions.findClosestBlock(nearbyLogs);
      const inventoryLogs = actions.countLogsInInventory();
      
      return {
        position: {x: pos.x, y: pos.y, z: pos.z},
        yaw: bot.entity.yaw,
        pitch: bot.entity.pitch,
        inventory_logs: inventoryLogs,
        tree_visible: nearbyLogs.length > 0,
        closest_log: closestLog ? {
          x: closestLog.position.x,
          y: closestLog.position.y,
          z: closestLog.position.z,
          distance: actions.distanceTo(closestLog.position)
        } : null
      };
    } catch (error) {
      console.error(`[${botId}] Error getting observation:`, error.message);
      return null;
    }
  }

  async startMessageLoop(botId) {
    const botData = this.bots.get(botId);
    if (!botData) return;
    
    console.log(`[${botId}] Starting message loop...`);
    
    while (botData.isConnected && !this.shuttingDown) {
      try {
        // Wait for message
        const [message] = await botData.socket.receive();
        
        // Check if we're still connected
        if (!botData.isConnected || this.shuttingDown) break;
        
        // Process message
        let request;
        try {
          request = JSON.parse(message.toString());
        } catch (e) {
          console.error(`[${botId}] Invalid JSON received:`, e.message);
          if (botData.socket && !botData.socket.closed) {
            await botData.socket.send(JSON.stringify({
              status: 'error',
              message: 'Invalid JSON'
            }));
          }
          continue;
        }
        
        let response = { status: 'ok' };
        
        // Check if bot is ready
        const isBotReady = botData.bot && botData.bot.entity && botData.actions && botData.bot.mcData;
        
        if (!isBotReady) {
          response = { 
            status: 'error', 
            message: `[${botId}] Bot not fully initialized` 
          };
        } else {
          // Process request based on type
          switch (request.type) {
            case 'get_state':
              response.state = botData.currentState || this.getObservation(botId) || {
                position: {x: 0, y: 0, z: 0},
                yaw: 0, pitch: 0,
                inventory_logs: 0,
                tree_visible: false,
                closest_log: null
              };
              break;
              
            case 'take_action':
              const result = await this.executeAction(botId, request.action);
              response.reward = result.reward;
              response.next_state = botData.currentState || {
                position: {x: 0, y: 0, z: 0},
                yaw: 0, pitch: 0,
                inventory_logs: 0,
                tree_visible: false,
                closest_log: null
              };
              response.done = result.done;
              break;
              
            case 'reset':
              await this.resetBot(botId);
              response.state = botData.currentState || {
                position: {x: 0, y: 0, z: 0},
                yaw: 0, pitch: 0,
                inventory_logs: 0,
                tree_visible: false,
                closest_log: null
              };
              break;
              
            case 'close':
              botData.isConnected = false;
              response.message = `[${botId}] Closing down`;
              break;

            case 'batch_actions':
              const batchResult = await this.processBatchedActions(
                botId, 
                request.actions
              );
              response = batchResult;
              break;
              
            default:
              response = { 
                status: 'error', 
                message: `[${botId}] Unknown request type: ${request.type}` 
              };
          }
        }
        
        // Small delay to avoid overwhelming the socket
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Send response
        if (botData.socket && !botData.socket.closed) {
          await botData.socket.send(JSON.stringify(response));
        } else {
          console.warn(`[${botId}] Socket closed before sending response`);
          botData.isConnected = false;
          break;
        }
      } catch (error) {
        // Handle ZMQ errors
        if (error.code === 'EAGAIN' || error.code === 'EFSM') {
          if (!botData.isConnected || this.shuttingDown) break;
        } else {
          console.error(`[${botId}] Error in message loop:`, error.message);
        }
        
        // Try to send error response
        if (botData.isConnected && botData.socket && !botData.socket.closed && !this.shuttingDown) {
          try {
            await botData.socket.send(JSON.stringify({
              status: 'error',
              message: `[${botId}] ${error.message || 'Unknown error'}`
            }));
          } catch (sendError) {
            console.error(`[${botId}] Failed to send error response:`, sendError.message);
            botData.isConnected = false;
            break;
          }
        } else if (!botData.isConnected || this.shuttingDown) {
          break;
        }
      }
    }
    
    console.log(`[${botId}] Message loop ended`);
    await this.cleanupBot(botId);
  }

  async executeAction(botId, actionIndex) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const botData = this.bots.get(botId);
    if (!botData) return { reward: -1, done: true };
    
    const { bot, actions } = botData;
    
    // Safety check
    if (!bot || !actions || !bot.mcData) {
      return { reward: -1, done: true };
    }
    
    let reward = 0;
    let done = false;
    
    const actionFunctions = [
      /* 0 */ async () => await actions.moveForward(),
      /* 1 */ async () => await actions.turnLeft(),
      /* 2 */ async () => await actions.turnRight(),
      /* 3 */ async () => await actions.jumpUp(),
      /* 4 */ async () => await actions.breakBlock()
    ];
    
    if (actionIndex >= 0 && actionIndex < actionFunctions.length) {
      try {
        const success = await actionFunctions[actionIndex]();
        
        if (actionIndex === 4 && success === true) {
          reward = 1.0;
          console.log(`[${botId}] Reward: +1.0 (Broke block)`);
        } else if (actionIndex === 4 && success === false) {
          reward = -0.1;
        } else {
          reward = -0.01; // Base movement cost
        }
      } catch (error) {
        console.error(`[${botId}] Error executing action ${actionIndex}:`, error.message);
        reward = -0.5;
      }
    } else {
      console.warn(`[${botId}] Invalid action index: ${actionIndex}`);
      reward = -0.2;
    }
    
    // Update state
    const newState = this.getObservation(botId);
    if (newState !== null) {
      botData.currentState = newState;
    }
    
    return { reward, done };
  }

  async processBatchedActions(botId, actions) {
    const botData = this.bots.get(botId);
    if (!botData) return { status: 'error', message: 'Bot not found' };
    
    const { bot, actions: botActions } = botData;
    if (!bot || !botActions) return { status: 'error', message: 'Bot not initialized' };
    
    const rewards = [];
    let done = false;
    
    // Execute all actions in sequence
    for (let i = 0; i < actions.length && !done; i++) {
      const actionIndex = actions[i];
      
      // Execute the action
      const result = await this.executeAction(botId, actionIndex);
      rewards.push(result.reward);
      
      // Check if done
      if (result.done) {
        done = true;
      }
    }
    
    // Get final state after all actions
    const finalState = this.getObservation(botId);
    
    return {
      status: 'ok',
      rewards,
      next_state: finalState,
      done
    };
  }

  async resetBot(botId) {
    const botData = this.bots.get(botId);
    if (!botData) return;
    
    const { bot, actions } = botData;
    
    // Safety check
    if (!bot || !actions || !bot.mcData) {
      console.error(`[${botId}] Cannot reset: bot not fully initialized`);
      return;
    }
    
    console.log(`[${botId}] Resetting bot (facing nearest tree)...`);
    
    try {
      await actions.findAndFaceNearestTree();
      
      // Update state
      const newState = this.getObservation(botId);
      if (newState !== null) {
        botData.currentState = newState;
      }
    } catch (error) {
      console.error(`[${botId}] Error resetting:`, error.message);
    }
    
    console.log(`[${botId}] Reset complete`);
  }

  async cleanupBot(botId) {
    console.log(`[${botId}] Cleaning up resources...`);
    
    const botData = this.bots.get(botId);
    if (!botData) return;
    
    // Close socket
    if (botData.socket && !botData.socket.closed) {
      try {
        await botData.socket.close();
        console.log(`[${botId}] Socket closed`);
      } catch (error) {
        if (error.code !== 'EFSM') {
          console.error(`[${botId}] Error closing socket:`, error.message);
        }
      }
    }
    
    // Disconnect bot
    if (botData.bot) {
      try {
        botData.bot.end(`[${botId}] Cleanup`);
        console.log(`[${botId}] Bot disconnected`);
      } catch (error) {
        console.error(`[${botId}] Error disconnecting bot:`, error.message);
      }
    }
    
    // Remove from map
    this.bots.delete(botId);
    console.log(`[${botId}] Cleanup complete`);
  }

  async shutdown() {
    console.log("\nInitiating server shutdown...");
    
    this.shuttingDown = true;
    
    // Close all bots
    const cleanupPromises = [];
    for (const botId of this.bots.keys()) {
      cleanupPromises.push(this.cleanupBot(botId));
    }
    
    await Promise.all(cleanupPromises);
    console.log("All bots cleaned up");
  }
}

module.exports = RLBridgeServer;