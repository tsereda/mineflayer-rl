"""
MinecraftEnv - Gymnasium environment for controlling Minecraft bots
Translates bot states and actions into RL-compatible format
"""

import numpy as np
import gymnasium as gym
from gymnasium import spaces
from typing import Dict, Any, Tuple, Optional

from minecraft_bridge import MinecraftBridge

class MinecraftEnv(gym.Env):
    """
    Custom Gym environment that interfaces with Mineflayer bot via ZeroMQ bridge
    """
    metadata = {'render.modes': ['human']}
    
    def __init__(self, bridge_host="127.0.0.1", bridge_port=5555, bot_id=0):
        """
        Initialize the environment
        
        Args:
            bridge_host (str): Host where the JavaScript bridge is running
            bridge_port (int): Port for ZMQ communication
            bot_id (int): Unique identifier for this bot
        """
        super(MinecraftEnv, self).__init__()
        
        self.bot_id = bot_id
        # Initialize connection to Minecraft bot
        self.bridge = MinecraftBridge(host=bridge_host, port=bridge_port, bot_id=bot_id)
        
        # Define action and observation space
        # Actions: move_forward, turn_left, turn_right, jump, break_block
        self.action_space = spaces.Discrete(5)
        
        # State space is continuous with 11 dimensions
        # [pos_x, pos_y, pos_z, sin_yaw, cos_yaw, pitch, tree_visible, 
        #  inventory_logs, distance_to_log, dir_x, dir_z]
        self.observation_space = spaces.Box(
            low=np.array([-1.0, -1.0, -1.0, -1.0, -1.0, -1.0, 0.0, 0.0, 0.0, -1.0, -1.0]),
            high=np.array([1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]),
            dtype=np.float32
        )
        
        # Initialize state
        self.current_state = None
        self.steps = 0
        self.max_steps = 100  # Maximum steps per episode
        self.total_logs_collected = 0
    
    def print_log(self, message):
        """Helper to log messages with bot ID prefix"""
        print(f"[Bot-{self.bot_id}] {message}")
    
    def process_state(self, state_dict: Dict[str, Any]) -> np.ndarray:
        """
        Convert state dictionary from JavaScript to normalized state vector
        
        Args:
            state_dict (dict): State dictionary from the JavaScript bridge
            
        Returns:
            np.ndarray: Normalized state vector for the RL agent
        """
        # Initialize with zeros
        state_vector = np.zeros(11, dtype=np.float32)
        
        # Bot position
        if 'position' in state_dict:
            pos = state_dict['position']
            state_vector[0:3] = [
                pos['x']/100.0,  # Normalize positions
                pos['y']/100.0,
                pos['z']/100.0
            ]
        
        # Orientation
        if 'yaw' in state_dict and 'pitch' in state_dict:
            state_vector[3:6] = [
                np.sin(state_dict['yaw']), 
                np.cos(state_dict['yaw']),
                state_dict['pitch'] / np.pi
            ]
        
        # Tree visibility and logs
        state_vector[6] = 1.0 if state_dict.get('tree_visible', False) else 0.0
        state_vector[7] = state_dict.get('inventory_logs', 0) / 10.0  # Normalize
        
        # Distance and direction to log
        closest_log = state_dict.get('closest_log', None)
        if closest_log:
            distance = min(closest_log['distance'] / 10.0, 1.0)  # Normalize
            
            # Direction vector to log (if available)
            dx = closest_log['x'] - state_dict['position']['x']
            dz = closest_log['z'] - state_dict['position']['z']
            length = np.sqrt(dx*dx + dz*dz)
            
            if length > 0:
                dx /= length
                dz /= length
            
            state_vector[8:11] = [distance, dx, dz]
        else:
            state_vector[8:11] = [1.0, 0.0, 0.0]  # Max distance, no direction
        
        return state_vector
    
    def step(self, action: int) -> Tuple[np.ndarray, float, bool, bool, Dict[str, Any]]:
        """
        Take a step in the environment by sending action to JS bot
        
        Args:
            action (int): Action index to execute
            
        Returns:
            tuple: (next_state, reward, terminated, truncated, info)
        """
        # Check if action is valid
        assert self.action_space.contains(action), f"Invalid action {action}"
        
        # Execute action in JS environment
        result = self.bridge.take_action(action)
        reward = result["reward"]
        next_state_dict = result["next_state"]
        done = result["done"]
        
        # Process state
        next_state_vector = self.process_state(next_state_dict)
        self.current_state = next_state_dict
        
        # Increment step counter
        self.steps += 1
        
        # Check if episode should end due to step limit
        truncated = self.steps >= self.max_steps
        terminated = done
        
        # Track logs collected
        current_logs = self.current_state.get("inventory_logs", 0)
        if current_logs > self.total_logs_collected:
            self.total_logs_collected = current_logs
        
        # Additional info
        info = {
            "logs_collected": current_logs,
            "steps": self.steps,
            "bot_id": self.bot_id
        }
        
        return next_state_vector, reward, terminated, truncated, info
    
    def reset(self, *, seed: Optional[int] = None, options: Optional[Dict[str, Any]] = None) -> Tuple[np.ndarray, Dict[str, Any]]:
        """
        Reset the environment and return the initial observation
        
        Args:
            seed (int, optional): Random seed
            options (dict, optional): Reset options
            
        Returns:
            tuple: (initial_state, info)
        """
        super().reset(seed=seed)
        
        # Reset the JavaScript environment
        state_dict = self.bridge.reset()
        self.current_state = state_dict
        
        # Reset step counter
        self.steps = 0
        
        # Process initial state
        state_vector = self.process_state(state_dict)
        
        # Info dict
        info = {
            "logs_collected": state_dict.get("inventory_logs", 0),
            "steps": self.steps,
            "bot_id": self.bot_id
        }
        
        return state_vector, info
    
    def close(self):
        """Close the environment and ZeroMQ connection"""
        if hasattr(self, 'bridge'):
            self.bridge.close()