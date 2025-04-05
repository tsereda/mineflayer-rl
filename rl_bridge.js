// JavaScript side (Mineflayer bot) - Optimized for LAN Connection with mcData fix
const mineflayer = require('mineflayer');
const zmq = require('zeromq');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const BotActions = require('./actions'); // Corrected require
// const Vec3 = require('vec3').Vec3; // Only needed if Vec3 used directly here

// Initialize the bridge
class RLBridge {
  constructor(options = {}) {
    this.zmqAddress = options.zmqAddress || '127.0.0.1';
    this.zmqPort = options.zmqPort || 5555; // Default ZMQ Port
    this.botOptions = options.botOptions || {};
    this.socket = new zmq.Reply();
    this.bot = null;
    this.actions = null;
    this.currentState = null;
    this.isConnected = false;
  }

  async init() {
    const bindAddress = `tcp://${this.zmqAddress}:${this.zmqPort}`;
    await this.socket.bind(bindAddress);
    console.log(`ZeroMQ server bound to ${bindAddress} (for Python connection)`);

    console.log('Connecting to Minecraft server:', this.botOptions);
    this.bot = mineflayer.createBot(this.botOptions);
    this.actions = new BotActions(this.bot); // Correctly instantiate

    console.log('Waiting for bot to spawn in Minecraft...');
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Bot spawn timed out (is Minecraft server running and accessible?)')), 60000);
        this.bot.once('spawn', () => {
            clearTimeout(timeout);
            console.log('Bot spawned successfully in Minecraft.');
            resolve();
        });
        this.bot.once('end', (reason) => {
            clearTimeout(timeout);
            reject(new Error(`Bot disconnected before spawning: ${reason}`));
        });
        this.bot.once('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`Bot connection error before spawning: ${err.message}`));
        })
    });

    // ---> Wait for mcData after spawn <---
    // Wait for mcData after spawn with manual attachment fallback
    let mcDataCheckCount = 0;
    const maxMcDataChecks = 100; // Reduced wait time since we'll manually attach
    const minecraftData = require('minecraft-data'); // Add this at the top of the file with other requires

    while (!this.bot.mcData && mcDataCheckCount < maxMcDataChecks) {
        console.log(`Waiting for mcData to load... (${mcDataCheckCount + 1}/${maxMcDataChecks})`);
        await new Promise(resolve => setTimeout(resolve, 100));
        mcDataCheckCount++;
    }

    // If mcData still not available, manually attach it
    if (!this.bot.mcData) {
        console.log("mcData not found after waiting. Attempting manual attachment...");
        if (this.bot.version) {
            this.bot.mcData = minecraftData(this.bot.version);
            console.log(`Manually attached mcData for version ${this.bot.version}`);
        } else {
            console.log("Cannot attach mcData: bot.version is undefined");
            throw new Error("Failed to determine Minecraft version for manual mcData attachment");
        }
    }

    // Verify mcData is now available
    if (!this.bot.mcData) {
        if (this.bot) {
            this.bot.end('mcData failed to load and manual attachment failed');
        }
        throw new Error("mcData failed to load after spawn and manual attachment. Cannot continue.");
    }

    console.log("mcData available - proceeding with bot initialization");
    // ---> END mcData Wait Section <---


    this.setupEventHandlers(); // Now safe to set up handlers that might use mcData indirectly
    this.isConnected = true;
    console.log('Starting ZeroMQ main loop (waiting for Python commands)...');
    this.mainLoop(); // Start processing requests
  }

  setupEventHandlers() {
    this.bot.on('physicsTick', () => {
      // Only get observation if bot is ready and actions are initialized
      if (this.bot && this.bot.entity && this.actions && this.bot.mcData) {
          this.currentState = this.getObservation();
      }
    });
    this.bot.on('error', (err) => {
        console.error("Mineflayer Bot Error:", err);
        // Consider more robust error handling, maybe attempt reconnect or shutdown
        // this.close().catch(console.error);
    });
    this.bot.on('kicked', (reason, loggedIn) => {
        console.error(`Bot kicked from server. Reason: ${reason}. Logged in: ${loggedIn}`);
        this.close().catch(console.error); // Shutdown on kick
    });
     this.bot.on('end', (reason) => {
        console.log(`Bot disconnected from Minecraft. Reason: ${reason}`);
        this.isConnected = false; // Stop ZMQ loop
        // Attempt cleanup, ensure called only once if end triggers close
        if(this.bot) { // Check if bot object still exists
            this.close().catch(e => console.error('Error during cleanup after disconnect:', e));
        }
     });
  }

  getObservation() {
    // Extra safeguard: Ensure needed components are ready
    if (!this.bot || !this.bot.entity || !this.actions || !this.bot.mcData) {
        // console.warn('Attempted to get observation before bot/entity/actions/mcData are ready.');
        return null;
    }
    const pos = this.bot.entity.position;
    // Add try...catch around potentially failing action calls
    try {
        const nearbyLogs = this.actions.findNearbyBlocks('log', 10);
        const closestLog = this.actions.findClosestBlock(nearbyLogs);
        const inventoryLogs = this.actions.countLogsInInventory();

        return {
          position: {x: pos.x, y: pos.y, z: pos.z},
          yaw: this.bot.entity.yaw,
          pitch: this.bot.entity.pitch,
          inventory_logs: inventoryLogs,
          tree_visible: nearbyLogs.length > 0,
          closest_log: closestLog ? {
            x: closestLog.position.x,
            y: closestLog.position.y,
            z: closestLog.position.z,
            distance: this.actions.distanceTo(closestLog.position)
          } : null
        };
    } catch (error) {
        console.error("Error during getObservation:", error);
        return null; // Return null or a default state on error
    }
  }

  async mainLoop() {
    while (this.isConnected) {
      try {
        const [message] = await this.socket.receive();
        if (!this.isConnected) break; // Re-check connection after potentially long wait

        const request = JSON.parse(message.toString());
        let response = {};
        let status = 'ok'; // Default status

        // Ensure bot and actions are ready before processing commands that need them
        const isBotReady = this.bot && this.bot.entity && this.actions && this.bot.mcData;

        if (request.type === 'get_state') {
          if (isBotReady) {
             response = { status: 'ok', state: this.currentState };
          } else {
             status = 'error';
             response = { status: status, message: 'Bot not fully ready for get_state' };
          }
        }
        else if (request.type === 'take_action') {
          if (isBotReady) {
              const actionIndex = request.action;
              const result = await this.executeAction(actionIndex);
              response = { status: 'ok', reward: result.reward, next_state: this.currentState, done: result.done };
          } else {
              status = 'error';
              response = { status: status, message: 'Bot not ready for take_action', reward: 0, next_state: null, done: true }; // Fail episode if not ready
          }
        }
        else if (request.type === 'reset') {
           if (isBotReady) {
               await this.reset();
               response = { status: 'ok', state: this.currentState };
           } else {
               status = 'error';
               response = { status: status, message: 'Bot not ready for reset', state: null };
           }
        }
         else if (request.type === 'close') {
             console.log('Received close request from Python client.');
             this.isConnected = false; // Signal loop to stop
             response = { status: 'ok', message: 'Closing down.'};
         }
        else {
           status = 'error';
           response = { status: status, message: 'Unknown request type' };
        }

        // Send response if socket still open
        if (this.socket && !this.socket.closed) {
            await this.socket.send(JSON.stringify(response));
        } else {
            console.warn("ZMQ Socket closed before sending response. Loop terminating.");
            this.isConnected = false; // Ensure loop terminates
        }

      } catch (error) {
        // Handle ZMQ/JSON errors
        if (error.code === 'EAGAIN' || error.code === 'EFSM') {
            console.warn(`ZeroMQ socket operation potentially interrupted (Code: ${error.code}). Shutting down? ${!this.isConnected}`);
             if (!this.isConnected) break; // Exit loop if intended shutdown
        } else {
            console.error('Error in ZMQ main loop:', error);
        }

        // Attempt to send error back to client if possible
        if (this.isConnected && this.socket && !this.socket.closed) {
          try {
            await this.socket.send(JSON.stringify({ status: 'error', message: error.message || 'Unknown ZMQ loop error.' }));
          } catch (sendError) {
            console.error('Failed to send ZMQ error response:', sendError);
             this.isConnected = false; // Assume client disconnected if send fails
          }
        } else if (!this.isConnected) {
             break; // Exit loop if already disconnected
        }
      }
    } // end while loop
    console.log("ZMQ Main loop finished.");
    await this.close(); // Ensure cleanup happens when loop ends
  }

  async executeAction(actionIndex) {
     // Safeguard already present, but good practice
     if (!this.bot || !this.actions || !this.bot.mcData) {
         console.error("Attempted executeAction before bot/actions/mcData ready.");
         return { reward: -1, done: true }; // Penalize and end episode
     }
    let reward = 0;
    let done = false;
    const actionFunctions = [
      /* 0 */ async () => await this.actions.moveForward(),
      /* 1 */ async () => await this.actions.turnLeft(),
      /* 2 */ async () => await this.actions.turnRight(),
      /* 3 */ async () => await this.actions.jumpUp(),
      /* 4 */ async () => await this.actions.breakBlock()
    ];

    if (actionIndex >= 0 && actionIndex < actionFunctions.length) {
      // console.log(`Executing Action: ${actionIndex}`); // Reduce logging noise
      try {
        const success = await actionFunctions[actionIndex]();
        if (actionIndex === 4 && success === true) { reward = 1.0; console.log("Reward: +1.0 (Broke block)"); }
        else if (actionIndex === 4 && success === false) { reward = -0.1; /* console.log("Reward: -0.1 (Failed breakBlock)"); */ }
        else { reward = -0.01; /* Base movement cost */ }
      } catch (actionError) {
          console.error(`Error executing action ${actionIndex}:`, actionError);
          reward = -0.5; // Penalize errors
          // done = true; // Optionally end episode on action error
      }
    } else {
        console.warn(`Invalid action index received: ${actionIndex}`);
        reward = -0.2; // Penalize invalid actions
    }

    // Update state *after* action potentially changes it
    // Ensure observation doesn't error out
    const newState = this.getObservation();
    if (newState !== null) {
        this.currentState = newState;
    } else {
        console.warn("getObservation returned null after action, state not updated.");
        // Decide how to handle this - maybe reuse old state or assign default?
        // For now, currentState might remain stale if getObservation fails.
    }

    // Add any termination conditions here, e.g.
    // if (this.bot.health.food <= 0) done = true;

    return { reward, done };
  }

  async reset() {
     // Safeguard needed here too
     if (!this.bot || !this.actions || !this.bot.mcData) {
         console.error("Attempted reset before bot/actions/mcData ready.");
         // What should reset return if not ready? Need consistent state format.
         // Maybe return a zeroed-out state or handle in Python?
         // For now, just log and let currentState potentially be null.
         return;
     }
    console.log("Resetting environment (facing nearest tree)...");
    try {
        await this.actions.findAndFaceNearestTree();
    } catch (resetError) {
        console.error("Error during reset action (findAndFaceNearestTree):", resetError);
    }
    // Update state after reset action attempt
    const newState = this.getObservation();
     if (newState !== null) {
        this.currentState = newState;
     } else {
        console.warn("getObservation returned null after reset, state not updated.");
     }
    console.log("Environment reset complete.");
  }

  async close() {
    console.log("Attempting graceful shutdown sequence...");
    // Prevent multiple close calls / check if already closed
    if (!this.isConnected && !this.bot && !this.socket) {
        console.log("Shutdown already complete or in progress.");
        return;
    }
    this.isConnected = false; // Signal loops to stop

    // Close socket safely
    if (this.socket && !this.socket.closed) {
      console.log("Closing ZeroMQ socket...");
      try {
          this.socket.close();
          console.log("ZeroMQ socket closed.");
      } catch (e) {
          // Ignore errors if already closing/closed
          if (e.code !== 'EFSM') console.error("Error closing ZMQ socket:", e);
      }
    }
    this.socket = null; // Release reference

    // Disconnect bot safely
    if (this.bot) {
      const tempBot = this.bot; // Store reference
      this.bot = null; // Set this.bot to null immediately to prevent race conditions in event handlers
      console.log("Disconnecting Mineflayer bot...");
      try {
          tempBot.end('RL bridge shutting down.'); // Use .end()
          console.log("Mineflayer bot disconnect requested.");
      } catch(e) {
          console.error("Error calling bot.end():", e);
      }
    }

    console.log("Shutdown sequence finished.");
  }
} // End of RLBridge Class

// --- Main Execution ---
async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: node $0 --mcHost <LAN_IP_Address> --mcPort <LAN_Port_Number> [options]')
    // --- Required Arguments for Minecraft Connection ---
    .option('mcHost', {
        alias: ['H', 'ip'], // Added 'ip' alias
        type: 'string',
        description: 'REQUIRED: The IP address of the computer hosting the Minecraft LAN game (find with ipconfig/ip addr)',
    })
    .option('mcPort', {
        alias: 'P',
        type: 'number',
        description: 'REQUIRED: The port number displayed in Minecraft chat after opening to LAN',
    })
    // --- Optional Arguments with Defaults ---
    .option('zmqPort', {
        alias: ['p', 'zmq-port'],
        type: 'number',
        description: 'Port for Python<->Node communication',
        default: 5555 // Default ZMQ Port
    })
     .option('mcUsername', {
        alias: ['u', 'username'],
        type: 'string',
        description: 'Minecraft bot username',
        default: 'RLBot' // Default username
    })
     .option('zmqAddress', {
        alias: ['a', 'zmq-address'],
        type: 'string',
        description: 'Address for Python<->Node communication',
        default: '127.0.0.1' // Default ZMQ address (localhost)
     })
     .option('mcAuth', {
        alias: ['auth'],
        type: 'string',
        description: 'Minecraft authentication method',
        default: 'offline' // Default to offline for LAN
     })
     .option('mcVersion', {
        alias: ['v', 'version'],
        type: 'string',
        description: 'Minecraft version (usually auto-detected)',
     })
     // --- Demand the required arguments ---
     .demandOption(['mcHost', 'mcPort'], 'Please provide the Minecraft host IP (--mcHost) and LAN port (--mcPort)')
    .help()
    .alias('help', 'h')
    .argv;

  let bridge = null;

  // Centralized shutdown logic
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Initiating shutdown...`);
    if (bridge) { // Check if bridge exists
        await bridge.close(); // Call close method
    } else {
        console.log("Bridge not initialized, exiting.");
    }
    // Allow time for async operations in close()
    setTimeout(() => process.exit(0), 1000); // Increased timeout slightly
  };

  // Register signal handlers ONCE
  process.once('SIGINT', () => shutdown('SIGINT')); // Handle Ctrl+C
  process.once('SIGTERM', () => shutdown('SIGTERM')); // Handle termination signal

  try {
      // Create RLBridge instance
      bridge = new RLBridge({
        zmqAddress: argv.zmqAddress,
        zmqPort: argv.zmqPort,
        botOptions: {
          host: argv.mcHost,       // REQUIRED via command line
          port: argv.mcPort,       // REQUIRED via command line
          username: argv.mcUsername, // Default: RLBot
          auth: argv.mcAuth,       // Default: offline
          version: argv.mcVersion  // Default: auto-detect
          // Add other mineflayer options here if needed
        }
      });

      console.log("Initializing RL Bridge...");
      await bridge.init(); // Initialize the bridge, including bot connection and mcData wait
      console.log("RL Bridge Ready. Connect your Python client now.");
      // Script will now stay alive running the mainLoop

  } catch (error) {
      // Catch initialization errors (e.g., connection failed, mcData timeout)
      console.error("-----------------------------------------");
      console.error("FATAL ERROR during initialization:", error.message);
      console.error("-----------------------------------------");
      if (bridge) {
         console.log("Attempting cleanup after initialization error...");
         await bridge.close().catch(e => console.error("Error during cleanup:", e));
      }
      process.exit(1); // Exit with error code
  }
}

// Run the main function
main();