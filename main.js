/**
 * Main entry point for the RL Bridge Server
 * Handles command line arguments and server initialization
 */
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const RLBridgeServer = require('./rl_bridge_server');

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: node $0 --ip <SERVER_IP> --port <PORT> [--num-bots <COUNT>] [--base-port <ZMQ_BASE_PORT>]')
    .option('ip', {
      type: 'string',
      description: 'Minecraft server IP address',
      demandOption: true
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      demandOption: true
    })
    .option('num-bots', {
      type: 'number',
      description: 'Number of bots to run in parallel',
      default: 3
    })
    .option('base-port', {
      type: 'number',
      description: 'Base ZMQ port (will use base-port to base-port+num-bots-1)',
      default: 5555
    })
    .help()
    .alias('help', 'h')
    .argv;

  let server = null;

  // Handle shutdown signals
  const handleShutdown = async (signal) => {
    console.log(`\nReceived ${signal} signal`);
    if (server) {
      await server.shutdown();
    }
    process.exit(0);
  };

  // Register signal handlers
  process.once('SIGINT', () => handleShutdown('SIGINT'));
  process.once('SIGTERM', () => handleShutdown('SIGTERM'));

  try {
    // Create and initialize server
    server = new RLBridgeServer({
      host: argv.ip,
      port: argv.port,
      numBots: argv['num-bots'],
      basePort: argv['base-port']
    });

    await server.init();
    console.log("\nRL Bridge Server ready - waiting for Python clients to connect");
    
  } catch (error) {
    console.error("\nFATAL ERROR:", error.message);
    
    if (server) {
      await server.shutdown().catch(e => 
        console.error("Error during shutdown:", e.message)
      );
    }
    
    process.exit(1);
  }
}

// Run the main function
main().catch(error => {
  console.error("Unhandled error in main:", error);
  process.exit(1);
});