/**
 * Actions and environment interactions for the Minecraft tree-cutting bot
 */

const Vec3 = require('vec3').Vec3;

class BotActions {
  constructor(bot) {
    this.bot = bot;
    this.mcData = null;
  }
  
  // Initialize minecraft data
  setMcData(mcData) {
    this.mcData = mcData;
  }

  // Basic movement actions
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

  // Break block action
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
    if (blockInSight.name.includes('log') || blockInSight.name.includes('leaves')) {
      try {
        console.log(`Breaking ${blockInSight.name} at ${blockInSight.position.x}, ${blockInSight.position.y}, ${blockInSight.position.z}`);
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
  }
  
  // Helper methods for finding blocks
  findNearbyBlocks(blockName, radius) {
    if (!this.mcData) {
      console.warn("McData not initialized");
      return [];
    }
    
    // Try different variations of log names
    let blockIds = [];
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
  
  countLogsInInventory() {
    if (!this.bot.inventory) return 0;
    
    return this.bot.inventory.items()
      .filter(item => item.name.includes('log'))
      .reduce((count, item) => count + item.count, 0);
  }
}

module.exports = BotActions;