const mineflayer = require('mineflayer');
const minecraftData = require('minecraft-data');

const options = {
    host: '192.168.0.234',
    port: 54063,
    username: 'TestBot',
    auth: 'offline',
    version: '1.21.1'
};

const bot = mineflayer.createBot(options);

// Manually attach mcData to bot when registry is available
bot.once('spawn', () => {
    console.log('Bot spawned successfully');
    
    // If mcData is missing but we have registry, manually add it
    if (!bot.mcData && bot.registry) {
        console.log('Manually attaching mcData to bot');
        bot.mcData = minecraftData(bot.version);
        console.log('mcData attached:', !!bot.mcData);
    }
    
    // Now you can use bot.mcData in your code
    console.log('Block data example:', bot.mcData.blocksByName.stone);
});

// Add other event handlers as needed