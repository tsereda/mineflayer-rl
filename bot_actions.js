/**
 * Actions class for Mineflayer bots to interact with Minecraft
 * Handles movement, block breaking, and environment sensing
 */
class BotActions {
  constructor(bot) {
    this.bot = bot;
    
    // Default movement constants
    this.MOVE_DISTANCE = 1.0;
    this.TURN_ANGLE = Math.PI / 4; // 45 degrees
    this.BREAK_REACH = 4.0;
    
    // Timeout constants
    this.ACTION_TIMEOUT = 1000;
  }
  
  /**
   * Finds blocks of a specific type within a given radius
   * @param {string} blockType - The type of block to find (e.g., 'log')
   * @param {number} radius - Search radius
   * @returns {Array} - Array of block objects
   */
  findNearbyBlocks(blockType, radius) {
    if (!this.bot || !this.bot.mcData) {
      console.log("Bot or mcData not available");
      return [];
    }
    
    try {
      // Debug: Print all block types
      //console.log("Available blocks:");
      const logBlocks = Object.keys(this.bot.mcData.blocksByName)
        .filter(name => name.includes('log') || name.includes('wood'));
      //console.log(`Found ${logBlocks.length} log/wood block types: ${logBlocks.join(', ')}`);
      
      // Create an array of block IDs to search for
      const blockIds = [];
      const possibleNames = ['log', 'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];
      
      for (const name of possibleNames) {
        if (this.bot.mcData.blocksByName[name]) {
          blockIds.push(this.bot.mcData.blocksByName[name].id);
        }
      }
      
      if (blockIds.length === 0) {
        console.warn("Could not find any log block types!");
        return [];
      }
      
      //console.log(`Searching for block IDs: ${blockIds.join(', ')}`);
      
      // Use a function to match any of our target blocks
      return this.bot.findBlocks({
        matching: (block) => blockIds.includes(block.type),
        maxDistance: radius,
        count: 64
      });
    } catch (error) {
      console.error(`Error finding ${blockType} blocks:`, error.message);
      return [];
    }
  }
  
  /**
   * Finds the closest block from an array of blocks
   * @param {Array} blocks - Array of block positions
   * @returns {Object|null} - Closest block or null if none found
   */
  findClosestBlock(blocks) {
    if (!blocks || blocks.length === 0 || !this.bot || !this.bot.entity) {
      return null;
    }
    
    let closestBlock = null;
    let closestDistance = Infinity;
    
    for (const blockPos of blocks) {
      try {
        const block = this.bot.blockAt(blockPos);
        if (!block) continue;
        
        const distance = this.distanceTo(block.position);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestBlock = block;
        }
      } catch (error) {
        console.error("Error processing block:", error.message);
      }
    }
    
    if (closestBlock) {
      //console.log(`Closest block: ${closestBlock.name} at ${JSON.stringify(closestBlock.position)}, distance: ${closestDistance.toFixed(2)}`);
    }
    
    return closestBlock;
  }
  
  /**
   * Calculates distance from bot to a position
   * @param {Object} position - Position with x, y, z coordinates
   * @returns {number} - Distance
   */
  distanceTo(position) {
    if (!this.bot || !this.bot.entity || !position) {
      return Infinity;
    }
    
    const botPos = this.bot.entity.position;
    const dx = botPos.x - position.x;
    const dy = botPos.y - position.y;
    const dz = botPos.z - position.z;
    
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  
  /**
   * Count logs in bot's inventory
   * @returns {number} - Number of logs
   */
  countLogsInInventory() {
    if (!this.bot || !this.bot.inventory || !this.bot.mcData) {
      return 0;
    }
    
    try {
      // Get IDs for all log types
      const logIds = Object.keys(this.bot.mcData.blocksByName)
        .filter(name => name.includes('log') || name.includes('wood'))
        .map(name => this.bot.mcData.blocksByName[name].id);
      
      // Count logs in inventory
      let count = 0;
      for (const item of this.bot.inventory.items()) {
        if (logIds.includes(item.type)) {
          count += item.count;
        }
      }
      
      return count;
    } catch (error) {
      console.error("Error counting logs:", error.message);
      return 0;
    }
  }
  
  /**
   * Move the bot forward
   * @returns {Promise<boolean>} - Success indicator
   */
  async moveForward() {
    if (!this.bot || !this.bot.entity) {
      return false;
    }
    
    console.log(`Moving forward from position: ${JSON.stringify(this.bot.entity.position)}`);
    
    return new Promise(resolve => {
      try {
        // Set movement control state
        this.bot.setControlState('forward', true);
        
        // Release control after timeout
        setTimeout(() => {
          this.bot.setControlState('forward', false);
          console.log(`Finished moving forward to: ${JSON.stringify(this.bot.entity.position)}`);
          resolve(true);
        }, this.ACTION_TIMEOUT);
      } catch (error) {
        console.error("Error moving forward:", error.message);
        this.bot.setControlState('forward', false);
        resolve(false);
      }
    });
  }
  
  /**
   * Turn the bot left
   * @returns {Promise<boolean>} - Success indicator
   */
  async turnLeft() {
    if (!this.bot || !this.bot.entity) {
      return false;
    }
    
    try {
      const oldYaw = this.bot.entity.yaw;
      console.log(`Before turning left: yaw = ${oldYaw.toFixed(2)}`);
      
      // Directly change yaw
      const newYaw = oldYaw + this.TURN_ANGLE;
      await this.bot.look(newYaw, this.bot.entity.pitch);
      
      console.log(`After turning left: yaw = ${this.bot.entity.yaw.toFixed(2)}`);
      return true;
    } catch (error) {
      console.error("Error turning left:", error.message);
      return false;
    }
  }
  
  /**
   * Turn the bot right
   * @returns {Promise<boolean>} - Success indicator
   */
  async turnRight() {
    if (!this.bot || !this.bot.entity) {
      return false;
    }
    
    try {
      const oldYaw = this.bot.entity.yaw;
      console.log(`Before turning right: yaw = ${oldYaw.toFixed(2)}`);
      
      // Directly change yaw
      const newYaw = oldYaw - this.TURN_ANGLE;
      await this.bot.look(newYaw, this.bot.entity.pitch);
      
      console.log(`After turning right: yaw = ${this.bot.entity.yaw.toFixed(2)}`);
      return true;
    } catch (error) {
      console.error("Error turning right:", error.message);
      return false;
    }
  }
  
  /**
   * Make the bot jump
   * @returns {Promise<boolean>} - Success indicator
   */
  async jumpUp() {
    if (!this.bot) {
      return false;
    }
    
    console.log(`Jumping from position: ${JSON.stringify(this.bot.entity.position)}`);
    
    return new Promise(resolve => {
      try {
        // Jump and move forward
        this.bot.setControlState('jump', true);
        this.bot.setControlState('forward', true);
        
        // Release control after timeout
        setTimeout(() => {
          this.bot.setControlState('jump', false);
          this.bot.setControlState('forward', false);
          console.log(`Finished jumping to: ${JSON.stringify(this.bot.entity.position)}`);
          resolve(true);
        }, this.ACTION_TIMEOUT);
      } catch (error) {
        console.error("Error jumping:", error.message);
        this.bot.setControlState('jump', false);
        this.bot.setControlState('forward', false);
        resolve(false);
      }
    });
  }
  
  /**
   * Break a block the bot is looking at
   * @returns {Promise<boolean>} - Success indicator
   */
  async breakBlock() {
    if (!this.bot) {
      return false;
    }
    
    try {
      // Find nearby logs
      const nearbyLogs = this.findNearbyBlocks('log', 5);
      console.log(`Found ${nearbyLogs.length} logs within break range`);
      
      if (nearbyLogs.length === 0) {
        console.log("No logs found nearby to break");
        return false;
      }
      
      // Find closest log
      const closestLog = this.findClosestBlock(nearbyLogs);
      
      if (!closestLog) {
        console.log("Could not determine closest log");
        return false;
      }
      
      // Look directly at the log
      console.log(`Looking at log at ${JSON.stringify(closestLog.position)}`);
      await this.bot.lookAt(closestLog.position);
      
      // Wait a moment for the bot to properly look at the block
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Get the block the bot is now looking at
      const blockInSight = this.bot.blockAtCursor(this.BREAK_REACH);
      
      if (!blockInSight) {
        console.log("No block in sight after looking at log position");
        return false;
      }
      
      console.log(`Now looking at: ${blockInSight.name} at ${JSON.stringify(blockInSight.position)}`);
      
      // Check if we're looking at a log or leaves
      if (blockInSight.name.includes('log') || blockInSight.name.includes('leaves')) {
        try {
          console.log(`Breaking ${blockInSight.name} at ${JSON.stringify(blockInSight.position)}`);
          await this.bot.dig(blockInSight);
          console.log("Successfully broke block!");
          return true;
        } catch (e) {
          console.log("Error breaking block:", e.message);
          return false;
        }
      } else {
        console.log(`Not breaking ${blockInSight.name} (not a log or leaves)`);
        return false;
      }
    } catch (error) {
      console.error("Error in breakBlock:", error.message);
      return false;
    }
  }
  
  /**
   * Find and face the nearest tree
   * @returns {Promise<boolean>} - Success indicator
   */
  async findAndFaceNearestTree() {
    if (!this.bot) {
      return false;
    }
    
    try {
      console.log(`Bot position: ${JSON.stringify(this.bot.entity.position)}`);
      
      // Find nearby logs with increased radius
      const logs = this.findNearbyBlocks('log', 50);
      console.log(`Found ${logs.length} logs nearby`);
      
      if (logs.length === 0) {
        console.log("No trees found nearby");
        return false;
      }
      
      // Find closest log
      const closestLog = this.findClosestBlock(logs);
      
      if (!closestLog) {
        console.log("Could not determine closest log");
        return false;
      }
      
      console.log(`Found nearest log at ${JSON.stringify(closestLog.position)}, distance: ${this.distanceTo(closestLog.position).toFixed(2)}`);
      
      // Look at the log
      await this.bot.lookAt(closestLog.position);
      console.log(`Now facing yaw: ${this.bot.entity.yaw.toFixed(2)}, pitch: ${this.bot.entity.pitch.toFixed(2)}`);
      
      return true;
    } catch (error) {
      console.error("Error finding and facing tree:", error.message);
      return false;
    }
  }
  
  /**
   * Print debug information about the bot's environment
   */
  printDebugInfo() {
    if (!this.bot || !this.bot.entity) {
      console.log("Bot not initialized for debug info");
      return;
    }
    
    // Check what block we're standing on
    const blockUnder = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    
    // Check what block we're looking at
    const blockInSight = this.bot.blockAtCursor(5);

  }
}

module.exports = BotActions;