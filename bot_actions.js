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
        return [];
      }
      
      try {
        const blockTypeId = this.bot.mcData.blocksByName[blockType]?.id;
        if (!blockTypeId) {
          return [];
        }
        
        return this.bot.findBlocks({
          matching: blockTypeId,
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
      
      return new Promise(resolve => {
        try {
          // Calculate forward position based on bot's yaw
          const yaw = this.bot.entity.yaw;
          const x = -Math.sin(yaw) * this.MOVE_DISTANCE;
          const z = -Math.cos(yaw) * this.MOVE_DISTANCE;
          
          // Set movement control state
          this.bot.setControlState('forward', true);
          
          // Release control after timeout
          setTimeout(() => {
            this.bot.setControlState('forward', false);
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
      
      return new Promise(resolve => {
        try {
          // Set movement control state
          this.bot.setControlState('left', true);
          
          // Release control after timeout
          setTimeout(() => {
            this.bot.setControlState('left', false);
            resolve(true);
          }, this.ACTION_TIMEOUT);
        } catch (error) {
          console.error("Error turning left:", error.message);
          this.bot.setControlState('left', false);
          resolve(false);
        }
      });
    }
    
    /**
     * Turn the bot right
     * @returns {Promise<boolean>} - Success indicator
     */
    async turnRight() {
      if (!this.bot || !this.bot.entity) {
        return false;
      }
      
      return new Promise(resolve => {
        try {
          // Set movement control state
          this.bot.setControlState('right', true);
          
          // Release control after timeout
          setTimeout(() => {
            this.bot.setControlState('right', false);
            resolve(true);
          }, this.ACTION_TIMEOUT);
        } catch (error) {
          console.error("Error turning right:", error.message);
          this.bot.setControlState('right', false);
          resolve(false);
        }
      });
    }
    
    /**
     * Make the bot jump
     * @returns {Promise<boolean>} - Success indicator
     */
    async jumpUp() {
      if (!this.bot) {
        return false;
      }
      
      return new Promise(resolve => {
        try {
          // Jump
          this.bot.setControlState('jump', true);
          
          // Release control after timeout
          setTimeout(() => {
            this.bot.setControlState('jump', false);
            resolve(true);
          }, this.ACTION_TIMEOUT);
        } catch (error) {
          console.error("Error jumping:", error.message);
          this.bot.setControlState('jump', false);
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
        // Find block at bot's eye position
        const targetBlock = this.bot.blockAtCursor(this.BREAK_REACH);
        
        if (!targetBlock || !targetBlock.position) {
          console.log("No block found to break");
          return false;
        }
        
        // Only break log blocks
        if (!targetBlock.name.includes("log") && !targetBlock.name.includes("wood")) {
          console.log(`Not breaking non-log block: ${targetBlock.name}`);
          return false;
        }
        
        // Try to break the block
        await this.bot.dig(targetBlock);
        console.log(`Broke block: ${targetBlock.name}`);
        return true;
      } catch (error) {
        console.error("Error breaking block:", error.message);
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
        // Find nearby logs
        const logs = this.findNearbyBlocks('log', 30);
        
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
        
        // Look at the log
        await this.bot.lookAt(closestLog.position);
        console.log("Facing nearest tree");
        return true;
      } catch (error) {
        console.error("Error finding and facing tree:", error.message);
        return false;
      }
    }
  }
  
  module.exports = BotActions;