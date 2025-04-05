// JavaScript side (Mineflayer bot)
const mineflayer = require('mineflayer');
const zmq = require('zeromq');
const yargs = require('yargs/yargs'); // Import yargs
const { hideBin } = require('yargs/helpers'); // Helper for yargs
const BotActions = require('./actions'); // <-- FIX APPLIED HERE (Removed braces) Assuming actions.js is in the same directory

// Initialize the bridge
class RLBridge {
  constructor(options = {}) {
    // Store the provided options
    this.zmqAddress = options.zmqAddress || '127.0.0.1'; // Default ZMQ address
    this.zmqPort = options.zmqPort || 5555;             // Default ZMQ port
    this.botOptions = options.botOptions || {};         // Bot connection options

    this.socket = new zmq.Reply();
    this.bot = null;
    this.actions = null;
    this.currentState = null;
    this.isConnected = false;
  }

  async init() {
    // Start ZeroMQ server using configured address and port
    const bindAddress = `tcp://${this.zmqAddress}:${this.zmqPort}`;
    await this.socket.bind(bindAddress);
    console.log(`ZeroMQ server bound to ${bindAddress}`);

    // Initialize Minecraft bot using configured options
    console.log('Connecting to Minecraft server:', this.botOptions);
    this.bot = mineflayer.createBot(this.botOptions);
    // This line should now work because BotActions is correctly required
    this.actions = new BotActions(this.bot);

    // Wait for bot to spawn
    console.log('Waiting for bot to spawn...');
    await new Promise((resolve, reject) => {
        // Timeout if spawn takes too long
        const timeout = setTimeout(() => reject(new Error('Bot spawn timed out')), 60000); // 60 seconds timeout
        this.bot.once('spawn', () => {
            clearTimeout(timeout);
            console.log('Bot spawned successfully.');
            resolve();
        });
        // Handle potential immediate disconnects or errors
        this.bot.once('end', (reason) => {
            clearTimeout(timeout);
            reject(new Error(`Bot disconnected before spawning: ${reason}`));
        });
        this.bot.once('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`Bot connection error before spawning: ${err.message}`));
        })
    });

    // Set up bot event handlers
    this.setupEventHandlers();

    // Start main loop
    this.isConnected = true;
    console.log('Starting ZeroMQ main loop...');
    this.mainLoop();
  }

  setupEventHandlers() {
    // Handle bot events relevant to RL
    this.bot.on('physicsTick', () => {
      // Update state on every physics tick
      // Ensure actions is initialized before trying to get observation
      if (this.actions) {
          this.currentState = this.getObservation();
      }
    });

    this.bot.on('error', (err) => {
        console.error("Mineflayer Bot Error:", err);
        // Consider how to handle errors, maybe try to shut down gracefully
        // this.close().catch(console.error);
    });

    this.bot.on('kicked', (reason, loggedIn) => {
        console.error(`Bot kicked from server. Reason: ${reason}. Logged in: ${loggedIn}`);
        this.close().catch(console.error); // Shut down on kick
    });

     this.bot.on('end', (reason) => {
        console.log(`Bot disconnected. Reason: ${reason}`);
        this.isConnected = false; // Stop the main loop
        // Ensure close is only called once if end triggers it
        // Check if bot object still exists before calling close again
        if(this.bot) {
            this.close().catch(e => console.error('Error during cleanup after disconnect:', e)); // Attempt cleanup
        }
     });
  }

  getObservation() {
    // Check if bot, entity and actions exist before accessing properties
    if (!this.bot || !this.bot.entity || !this.actions) {
        console.warn('Attempted to get observation before bot/entity/actions are ready.');
        return null; // Or return a default 'not ready' state
    }
    // Extract relevant state information
    const pos = this.bot.entity.position;
    const nearbyLogs = this.actions.findNearbyBlocks('log', 10); // Make sure BotActions handles potential errors
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
        if (!this.isConnected) break; // Check connection status after potentially long wait

        const request = JSON.parse(message.toString());
        let response = {};

        if (request.type === 'get_state') {
          // Return current state
          response = {
            status: 'ok',
            state: this.currentState
          };
        }
        else if (request.type === 'take_action') {
          // Execute action and return result
          const actionIndex = request.action;
          const result = await this.executeAction(actionIndex);

          response = {
            status: 'ok',
            reward: result.reward,
            next_state: this.currentState, // State might have updated during action
            done: result.done
          };
        }
        else if (request.type === 'reset') {
          // Reset the environment
          await this.reset();
          response = {
            status: 'ok',
            state: this.currentState
          };
        }
         else if (request.type === 'close') {
             console.log('Received close request from client.');
             this.isConnected = false; // Signal loop to stop
             response = { status: 'ok', message: 'Closing down.'};
         }
        else {
          response = {
            status: 'error',
            message: 'Unknown request type'
          };
        }
        // Ensure socket is still available before sending
        if (this.socket && !this.socket.closed) {
            await this.socket.send(JSON.stringify(response));
        } else {
            console.warn("Socket closed before sending response. Loop will terminate.");
            this.isConnected = false; // Ensure loop terminates if socket closed unexpectedly
        }

      } catch (error) {
        // Handle potential errors like client disconnecting or JSON parsing errors
        if (error.code === 'EAGAIN' || error.code === 'EFSM') {
             // EAGAIN might happen if receive is interrupted (e.g. during shutdown)
             // EFSM relates to ZeroMQ state machine issues, often during close
            console.warn(`ZeroMQ socket operation interrupted (Code: ${error.code}). Possibly shutting down.`);
             if (!this.isConnected) break; // Exit loop if we intended to shut down
        } else {
            console.error('Error in main loop:', error);
        }

        if (this.isConnected && this.socket && !this.socket.closed) { // Check if socket is usable
          try {
            // Attempt to send an error response ONLY if the socket seems okay
            await this.socket.send(JSON.stringify({
              status: 'error',
              message: error.message || 'An unknown error occurred in the main loop.'
            }));
          } catch (sendError) {
            console.error('Failed to send error response (socket might be closed or in bad state):', sendError);
            // If sending fails, the client likely disconnected or socket is broken, break loop
             this.isConnected = false;
          }
        } else if (!this.isConnected) {
             console.log("Exiting main loop due to isConnected=false.");
             break; // Exit loop if intentionally disconnected
        }
      }
    }
    console.log("Main loop finished.");
    await this.close(); // Ensure cleanup happens when loop ends
  }

  async executeAction(actionIndex) {
     // Check initialization *before* accessing this.actions
     if (!this.bot || !this.actions) {
         console.error("Cannot execute action: Bot or actions not initialized.");
         return { reward: 0, done: true }; // Indicate failure/end state
     }
    // Execute the action in Minecraft
    let reward = 0;
    let done = false; // 'done' usually signifies the end of an episode in RL

    // Define action functions more robustly
    const actionFunctions = [
      /* 0 */ async () => { console.log("Action: moveForward"); return await this.actions.moveForward(); },
      /* 1 */ async () => { console.log("Action: turnLeft"); return await this.actions.turnLeft(); },
      /* 2 */ async () => { console.log("Action: turnRight"); return await this.actions.turnRight(); },
      /* 3 */ async () => { console.log("Action: jumpUp"); return await this.actions.jumpUp(); },
      /* 4 */ async () => { console.log("Action: breakBlock"); return await this.actions.breakBlock(); } // Assuming breakBlock targets a nearby block
    ];

    if (actionIndex >= 0 && actionIndex < actionFunctions.length) {
      try {
        // Access actions via this.actions
        const success = await actionFunctions[actionIndex](); // Wait for action to complete

        // Calculate reward based on action outcome
        if (actionIndex === 4 && success === true) { // Action 4 is breakBlock
          reward = 1.0; // Positive reward for successfully breaking a block (likely a log)
          console.log("Reward: +1.0 (Broke block)");
        } else if (actionIndex === 4 && success === false) {
            reward = -0.1; // Small penalty for failing to break (e.g., nothing targetable)
            console.log("Reward: -0.1 (Failed breakBlock)");
        } else {
            // Small negative reward for movement/other actions to encourage efficiency
            reward = -0.01;
             console.log(`Reward: -0.01 (Action ${actionIndex})`);
        }

        // Potentially add logic for 'done' state, e.g., if bot health is low, inventory full, task completed etc.
        // done = checkCompletionCondition();

      } catch (actionError) {
          console.error(`Error executing action ${actionIndex}:`, actionError);
          reward = -0.5; // Penalize errors during action execution
          // done = true; // Optionally end episode on error
      }
    } else {
        console.warn(`Invalid action index received: ${actionIndex}`);
        reward = -0.2; // Penalize invalid actions
    }

    // Update state *after* action potentially changes it
    this.currentState = this.getObservation();

    return { reward, done };
  }

  async reset() {
    console.log("Resetting environment...");
     // Check initialization *before* accessing this.actions
     if (!this.bot || !this.actions) {
         console.error("Cannot reset: Bot or actions not initialized.");
         return;
     }
    // Implement a more robust reset, e.g., teleporting bot, clearing inventory (if needed)
    // For now, just face nearest tree and update state
    try {
        // Example: Teleport to a known safe spot if available via commands
        // await this.bot.chat('/tp @s <x> <y> <z>');
        // await new Promise(r => setTimeout(r, 500)); // Wait briefly after teleport

        // Access actions via this.actions
        await this.actions.findAndFaceNearestTree(); // Make sure this handles 'no trees found'
    } catch (resetError) {
        console.error("Error during reset actions:", resetError);
    }
    this.currentState = this.getObservation(); // Get state after reset actions
    console.log("Environment reset complete.");
  }

  async close() {
    console.log("Closing RLBridge...");
    // Prevent multiple close calls / ensure idempotency somewhat
    if (!this.isConnected && !this.bot && !this.socket) {
        console.log("Close already initiated or completed.");
        return;
    }
    this.isConnected = false; // Ensure loop stops

    // Close socket safely
    if (this.socket && !this.socket.closed) {
      console.log("Closing ZeroMQ socket...");
      try {
          // For zeromq < 6, close is sync. For >= 6, it might be async (check docs if needed)
          this.socket.close();
          console.log("ZeroMQ socket closed.");
      } catch (e) {
          // Ignore potential errors if already closing/closed
          if (e.code !== 'EFSM') { // EFSM error can happen if already closed
              console.error("Error closing ZeroMQ socket:", e);
          }
      }
    }
    this.socket = null; // Release reference

    // Disconnect bot safely
    if (this.bot) {
      console.log("Disconnecting Mineflayer bot...");
      try {
          // Use end() instead of quit() <-- FIX APPLIED HERE
          this.bot.end('Shutting down RL bridge');
          console.log("Mineflayer bot disconnected via end().");
      } catch(e) {
          // Catch potential errors if bot disconnects abruptly
          console.error("Error calling bot.end():", e)
      }
    }
    this.bot = null; // Release reference

    console.log("RLBridge close sequence finished.");
  }
}

// --- Main Execution ---
async function main() {
  // Parse command line arguments using yargs
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: node $0 [options]')
    .option('zmqAddress', {
      alias: ['a', 'zmq-address'],
      type: 'string',
      description: 'ZeroMQ server binding address',
      default: '127.0.0.1' // Default ZMQ address
    })
    .option('zmqPort', {
      alias: ['p', 'zmq-port'],
      type: 'number',
      description: 'ZeroMQ server binding port',
      default: 5555 // Default ZMQ port
    })
    .option('mcHost', {
        alias: ['H', 'mc-host'],
        type: 'string',
        description: 'Minecraft server host',
        default: 'localhost' // Default Minecraft host
    })
    .option('mcPort', {
        alias: ['P', 'mc-port'],
        type: 'number',
        description: 'Minecraft server port',
        default: 25565 // Default Minecraft port
    })
     .option('mcUsername', {
        alias: ['u', 'username'],
        type: 'string',
        description: 'Minecraft bot username',
        default: 'RLBot' // Default username
    })
    // Add auth, version options if needed
    .option('mcAuth', {
        alias: ['auth'],
        type: 'string',
        description: 'Minecraft authentication method (e.g., "microsoft", "mojang", "offline")',
        default: 'offline' // Default to offline for local testing
    })
     .option('mcVersion', {
        alias: ['v', 'version'],
        type: 'string',
        description: 'Minecraft version (optional, let Mineflayer auto-detect if possible)',
        // No default, let mineflayer auto-detect if not provided
    })
    .help()
    .alias('help', 'h')
    .argv;

  let bridge = null; // Define bridge variable outside try block for access in finally/catch

  // Centralized shutdown logic
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    // Avoid calling close multiple times if signal received rapidly
    if (bridge && (bridge.isConnected || bridge.bot || bridge.socket)) {
        await bridge.close();
    } else {
        console.log("Shutdown already in progress or completed.");
    }
    // Give a brief moment for async operations in close to attempt completion
    setTimeout(() => process.exit(0), 500);
  };

  // Register signal handlers once
  process.once('SIGINT', () => shutdown('SIGINT')); // Ctrl+C
  process.once('SIGTERM', () => shutdown('SIGTERM')); // Termination signal


  try {
      // Create RLBridge instance with parsed arguments
      bridge = new RLBridge({
        zmqAddress: argv.zmqAddress,
        zmqPort: argv.zmqPort,
        botOptions: {
          host: argv.mcHost,
          port: argv.mcPort,
          username: argv.mcUsername,
          auth: argv.mcAuth,
          version: argv.mcVersion // Pass version if provided
          // Add other mineflayer options here if needed, e.g., password
        }
      });

      console.log("Initializing RL Bridge...");
      await bridge.init(); // Initialize the bridge and bot connection

       console.log("RL Bridge is running. Waiting for Python client connection and commands...");
       // Keep Node.js process alive implicitly while mainLoop runs
       // If mainLoop exits gracefully (e.g., via 'close' command), cleanup happens there.


  } catch (error) {
      console.error("Fatal error during initialization or execution:", error);
      if (bridge) {
         console.log("Attempting cleanup after error...");
         // Ensure cleanup runs even if init failed partially
         await bridge.close().catch(e => console.error("Error during cleanup after main error:", e));
      }
      process.exit(1); // Exit with error code
  }
}

// Run the main function
main();