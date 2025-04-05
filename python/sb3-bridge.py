"""
PPO implementation using Stable-Baselines3 with JavaScript Mineflayer bot bridge
"""

import json
import time
import numpy as np
import gymnasium as gym
from gymnasium import spaces
import zmq
from typing import Dict, Any, Tuple, List, Optional

# Import Stable-Baselines3
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import DummyVecEnv
from stable_baselines3.common.monitor import Monitor

class MinecraftBridge:
    """Bridge between Python and JavaScript Mineflayer bot using ZeroMQ"""
    def __init__(self, host="127.0.0.1", port=5555, timeout=30000):
        # Initialize ZeroMQ connection
        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.REQ)
        self.socket.connect(f"tcp://{host}:{port}")
        self.socket.setsockopt(zmq.RCVTIMEO, timeout)  # 10 second timeout
    
    def get_state(self) -> Dict[str, Any]:
        """Get current state from the JS bot"""
        self.socket.send_json({"type": "get_state"})
        response = self.socket.recv_json()
        if response["status"] != "ok":
            raise Exception(f"Error getting state: {response.get('message', 'Unknown error')}")
        return response["state"]
    
    def take_action(self, action: int) -> Dict[str, Any]:
        """Send action to the JS bot and get result"""
        self.socket.send_json({"type": "take_action", "action": int(action)})
        response = self.socket.recv_json()
        if response["status"] != "ok":
            raise Exception(f"Error taking action: {response.get('message', 'Unknown error')}")
        return {
            "reward": response["reward"],
            "next_state": response["next_state"],
            "done": response["done"]
        }
    
    def reset(self) -> Dict[str, Any]:
        """Reset environment in the JS bot"""
        self.socket.send_json({"type": "reset"})
        response = self.socket.recv_json()
        if response["status"] != "ok":
            raise Exception(f"Error resetting: {response.get('message', 'Unknown error')}")
        return response["state"]
    
    def close(self):
        """Close the ZeroMQ connection"""
        self.socket.close()
        self.context.term()

class MinecraftEnv(gym.Env):
    """
    Custom Gym environment that interfaces with Mineflayer bot via ZeroMQ bridge
    """
    metadata = {'render.modes': ['human']}
    
    def __init__(self, bridge_host="127.0.0.1", bridge_port=5555):
        super(MinecraftEnv, self).__init__()
        
        # Initialize connection to Minecraft bot
        self.bridge = MinecraftBridge(host=bridge_host, port=bridge_port)
        
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
        self.max_steps = 200  # Maximum steps per episode
    
    def process_state(self, state_dict: Dict[str, Any]) -> np.ndarray:
        """Convert state dictionary from JavaScript to normalized state vector"""
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
        
        Returns:
            observation: The agent's observation of the current environment
            reward: The reward for taking the action
            terminated: Whether the episode has ended
            truncated: Whether the episode was truncated (e.g., due to time limit)
            info: Additional information
        """
        # Check if action is valid
        assert self.action_space.contains(action), "Invalid action"
        
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
        
        # Additional info
        info = {
            "logs_collected": self.current_state.get("inventory_logs", 0),
            "steps": self.steps
        }
        
        return next_state_vector, reward, terminated, truncated, info
    
    def reset(self, *, seed: Optional[int] = None, options: Optional[Dict[str, Any]] = None) -> Tuple[np.ndarray, Dict[str, Any]]:
        """
        Reset the environment and return the initial observation
        
        Returns:
            observation: The initial observation
            info: Additional information
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
            "steps": self.steps
        }
        
        return state_vector, info
    
    def close(self):
        """Close the environment and ZeroMQ connection"""
        if hasattr(self, 'bridge'):
            self.bridge.close()

class LoggingCallback(BaseCallback):
    """
    Custom callback for logging training progress
    """
    def __init__(self, verbose=0):
        super(LoggingCallback, self).__init__(verbose)
        self.episode_rewards = []
        self.episode_lengths = []
        self.current_episode_reward = 0
        self.logs_collected = 0
    
    def _on_step(self) -> bool:
        """
        Called at each step of training
        """
        # Update episode reward
        self.current_episode_reward += self.locals['rewards'][0]
        
        # Get logs collected if available
        if 'infos' in self.locals and len(self.locals['infos']) > 0:
            if 'logs_collected' in self.locals['infos'][0]:
                self.logs_collected = self.locals['infos'][0]['logs_collected']
        
        # Check if episode has ended
        if self.locals['dones'][0]:
            # Log episode stats
            self.episode_rewards.append(self.current_episode_reward)
            self.episode_lengths.append(self.num_timesteps - sum(self.episode_lengths))
            
            # Print episode summary
            avg_reward = np.mean(self.episode_rewards[-10:]) if len(self.episode_rewards) > 0 else 0
            print(f"Episode: {len(self.episode_rewards)}")
            print(f"  Reward: {self.current_episode_reward:.2f}")
            print(f"  Length: {self.episode_lengths[-1]}")
            print(f"  Logs Collected: {self.logs_collected}")
            print(f"  Avg Reward (10 ep): {avg_reward:.2f}")
            
            # Reset current episode stats
            self.current_episode_reward = 0
        
        return True

def make_env(bridge_host="127.0.0.1", bridge_port=5555):
    """Create a wrapped environment for Stable-Baselines3"""
    env = MinecraftEnv(bridge_host=bridge_host, bridge_port=bridge_port)
    # Wrap with Monitor for logging episode stats
    env = Monitor(env)
    return env

def train_sb3_ppo(
    bridge_host="127.0.0.1", 
    bridge_port=5555, 
    total_timesteps=100000,
    save_path="minecraft_ppo",
    learning_rate=3e-4,
    n_steps=100,
    batch_size=64,
    n_epochs=10,
    gamma=0.99,
    gae_lambda=0.95,
    clip_range=0.2,
    verbose=1
):
    """
    Train a PPO agent using Stable-Baselines3
    """
    # Create environment factory
    def env_fn():
        return make_env(bridge_host=bridge_host, bridge_port=bridge_port)
    
    # Create vectorized environment
    env = DummyVecEnv([env_fn])
    
    # Create PPO model
    model = PPO(
        "MlpPolicy",
        env,
        learning_rate=learning_rate,
        n_steps=n_steps,
        batch_size=batch_size,
        n_epochs=n_epochs,
        gamma=gamma,
        gae_lambda=gae_lambda,
        clip_range=clip_range,
        verbose=verbose,
        tensorboard_log="./minecraft_ppo_tensorboard/"
    )
    
    # Create callback for logging
    callback = LoggingCallback()
    
    try:
        # Train the model
        model.learn(total_timesteps=total_timesteps, callback=callback)
        
        # Save model
        model.save(save_path)
        print(f"Model saved to {save_path}")
    
    except KeyboardInterrupt:
        # Save model on keyboard interrupt
        print("Training interrupted, saving model...")
        model.save(f"{save_path}_interrupted")
        print(f"Model saved to {save_path}_interrupted")
    
    finally:
        # Close environment
        env.close()
    
    return model

if __name__ == "__main__":
    # Train a PPO agent
    bridge_host = "127.0.0.1"
    bridge_port = 5555
    
    print(f"Training PPO agent with Stable-Baselines3")
    print(f"Connecting to JavaScript bridge at {bridge_host}:{bridge_port}")
    
    model = train_sb3_ppo(
        bridge_host=bridge_host,
        bridge_port=bridge_port,
        total_timesteps=100000,  # Adjust based on your needs
        save_path="minecraft_ppo_model"
    )
