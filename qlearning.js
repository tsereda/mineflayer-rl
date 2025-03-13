/**
 * Q-learning implementation for the Minecraft tree-cutting bot
 */

class QAgent {
    constructor(options = {}) {
      // RL parameters
      this.epsilon = options.epsilon || 0.2;  // Exploration rate (20% random actions)
      this.learning_rate = options.learning_rate || 0.1;
      this.discount_factor = options.discount_factor || 0.9;
      this.q_table = {};  // Simple state-action value function
      this.actions_count = options.actions_count || 5;
    }
  
    // Enhanced state representation with directional awareness
    getStateKey(observation) {
      const hasLog = observation.tree_visible;
      let distanceBucket = 'none';
      let direction = 'none';
      
      if (hasLog && observation.closest_log) {
        // Distance categories
        const distance = observation.closest_log.distance;
        if (distance < 3) distanceBucket = 'close';
        else if (distance < 6) distanceBucket = 'medium';
        else distanceBucket = 'far';
        
        // Direction calculation
        const botPosition = observation.position;
        const logPosition = {
          x: observation.closest_log.x,
          z: observation.closest_log.z
        };
        const botYaw = observation.yaw;
        
        // Calculate angle between bot's facing direction and log
        const dx = logPosition.x - botPosition.x;
        const dz = logPosition.z - botPosition.z;
        const angleToLog = Math.atan2(dz, dx);
        
        // Convert to relative angle (difference between bot's facing and angle to log)
        let relativeAngle = angleToLog - botYaw;
        
        // Normalize to -π to π
        while (relativeAngle > Math.PI) relativeAngle -= 2 * Math.PI;
        while (relativeAngle < -Math.PI) relativeAngle += 2 * Math.PI;
        
        // Categorize direction
        if (relativeAngle > -Math.PI/4 && relativeAngle < Math.PI/4) {
          direction = 'front';
        } else if (relativeAngle >= Math.PI/4 && relativeAngle < 3*Math.PI/4) {
          direction = 'right';
        } else if (relativeAngle <= -Math.PI/4 && relativeAngle > -3*Math.PI/4) {
          direction = 'left';
        } else {
          direction = 'behind';
        }
      }
      
      return `log_${hasLog ? 'visible' : 'none'}_${distanceBucket}_${direction}`;
    }
    
    // Choose action using epsilon-greedy policy
    chooseAction(state) {
      // With probability epsilon, choose a random action (exploration)
      if (Math.random() < this.epsilon) {
        return Math.floor(Math.random() * this.actions_count);
      }
      
      // Otherwise, choose the best action from our Q-table (exploitation)
      const stateKey = this.getStateKey(state);
      if (!this.q_table[stateKey]) {
        this.q_table[stateKey] = Array(this.actions_count).fill(0);
      }
      
      // Find action with maximum Q-value
      return this.q_table[stateKey].indexOf(Math.max(...this.q_table[stateKey]));
    }
    
    // Update Q-table with new experience
    updateQTable(stateKey, action, reward, nextStateKey) {
      if (!this.q_table[stateKey]) {
        this.q_table[stateKey] = Array(this.actions_count).fill(0);
      }
      
      if (!this.q_table[nextStateKey]) {
        this.q_table[nextStateKey] = Array(this.actions_count).fill(0);
      }
      
      // Q-learning update: Q(s,a) = Q(s,a) + α [r + γ * max Q(s',a') - Q(s,a)]
      const oldValue = this.q_table[stateKey][action];
      const nextMax = Math.max(...this.q_table[nextStateKey]);
      
      // Update rule
      this.q_table[stateKey][action] = oldValue + this.learning_rate * 
        (reward + this.discount_factor * nextMax - oldValue);
    }
    
    // Decrease exploration rate over time
    decayEpsilon(minEpsilon = 0.05, decayRate = 0.9) {
      this.epsilon = Math.max(minEpsilon, this.epsilon * decayRate);
      return this.epsilon;
    }
    
    // Get full Q-table for debugging
    getQTable() {
      return this.q_table;
    }
  }
  
  module.exports = QAgent;