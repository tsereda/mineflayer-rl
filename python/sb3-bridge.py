"""
PPO implementation using Stable-Baselines3 with JavaScript Mineflayer bot bridge
With Weights & Biases integration for improved monitoring
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

# Import Weights & Biases
import wandb
from wandb.integration.sb3 import WandbCallback

class MinecraftBridge:
    """Bridge between Python and JavaScript Mineflayer bot using ZeroMQ"""
    def __init__(self, host="127.0.0.1", port=5555, timeout=30000):
        # Initialize ZeroMQ connection
        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.REQ)
        self.socket.connect(f"tcp://{host}:{port}")
        self.socket.setsockopt(zmq.RCVTIMEO, timeout)  # 30 second timeout
    
    def get_state(self) -> Dict[str, Any]:
        """Get current state from the JS bot"""
        self.socket.send_json({"type": "get_state"})
        response = self.socket.recv_json()
        if response["status"] != "ok":
            raise Exception(f"Error getting state: {response.get('message', 'Unknown error')}")
        return response["state"]
    
    def take_action(self, action: int, max_retries=3) -> Dict[str, Any]:
        """Send action to the JS bot and get result with retries"""
        for attempt in range(max_retries):
            try:
                self.socket.send_json({"type": "take_action", "action": int(action)})
                response = self.socket.recv_json()
                if response["status"] != "ok":
                    raise Exception(f"Error taking action: {response.get('message', 'Unknown error')}")
                return {
                    "reward": response["reward"],
                    "next_state": response["next_state"],
                    "done": response["done"]
                }
            except zmq.error.Again:
                print(f"ZMQ timeout on attempt {attempt+1}/{max_retries}, retrying...")
                time.sleep(1)
        
        # If all retries fail, force episode end
        print("All retries failed, forcing episode end")
        return {
            "reward": -1.0,
            "next_state": self.get_state(),  # Try to get current state
            "done": True  # Force episode end
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
    Custom callback for logging training progress with W&B integration
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
        
        # Log to W&B every 20 steps
        if self.num_timesteps % 20 == 0:
            wandb.log({
                "current/logs_collected": self.logs_collected,
                "current/episode_reward": self.current_episode_reward,
                "current/timestep": self.num_timesteps
            }, step=self.num_timesteps)
        
        # Check if episode has ended
        if self.locals['dones'][0]:
            # Log episode stats
            self.episode_rewards.append(self.current_episode_reward)
            self.episode_lengths.append(self.num_timesteps - sum(self.episode_lengths))
            
            # Calculate average reward
            avg_reward = np.mean(self.episode_rewards[-10:]) if len(self.episode_rewards) >= 10 else np.mean(self.episode_rewards)
            
            # Log to W&B
            wandb.log({
                "episode/number": len(self.episode_rewards),
                "episode/reward": self.current_episode_reward,
                "episode/length": self.episode_lengths[-1],
                "episode/logs_collected": self.logs_collected,
                "episode/avg_reward_10": avg_reward
            }, step=self.num_timesteps)
            
            # Print episode summary
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
    Train a PPO agent using Stable-Baselines3 with W&B integration
    """
    # Initialize wandb
    run = wandb.init(
        project="minecraft-rl",
        config={
            "algorithm": "PPO",
            "environment": "Minecraft-Tree-Cutting",
            "learning_rate": learning_rate,
            "n_steps": n_steps,
            "batch_size": batch_size,
            "n_epochs": n_epochs,
            "gamma": gamma,
            "gae_lambda": gae_lambda,
            "clip_range": clip_range,
            "bridge_host": bridge_host,
            "bridge_port": bridge_port
        }
    )
    
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
        verbose=verbose
        )
    
    # Create callbacks
    logging_callback = LoggingCallback()
    wandb_callback = WandbCallback(
        verbose=2,
        model_save_path=f"models/{run.id}",
        model_save_freq=1000,
        gradient_save_freq=0  # Disable gradient saving to reduce overhead
    )
    
    try:
        # Train the model with both callbacks
        model.learn(
            total_timesteps=total_timesteps, 
            callback=[logging_callback, wandb_callback]
        )
        
        # Save final model
        final_model_path = f"{save_path}_{run.id}"
        model.save(final_model_path)
        
        # Log model artifact to W&B
        wandb.save(final_model_path + ".zip")
        print(f"Model saved to {final_model_path}")
    
    except KeyboardInterrupt:
        # Save model on keyboard interrupt
        print("Training interrupted, saving model...")
        interrupted_model_path = f"{save_path}_interrupted_{run.id}"
        model.save(interrupted_model_path)
        
        # Log interrupted model artifact to W&B
        wandb.save(interrupted_model_path + ".zip")
        print(f"Model saved to {interrupted_model_path}")
    
    except Exception as e:
        print(f"Error during training: {e}")
        # Try to save model even if there's an error
        try:
            error_model_path = f"{save_path}_error_{run.id}"
            model.save(error_model_path)
            wandb.save(error_model_path + ".zip")
            print(f"Model saved to {error_model_path} despite error")
        except:
            print("Could not save model after error")
    
    finally:
        # Close environment
        env.close()
        # Finish wandb run
        run.finish()
    
    return model

if __name__ == "__main__":
    # Train a PPO agent
    bridge_host = "127.0.0.1"
    bridge_port = 5555
    
    print(f"Training PPO agent with Stable-Baselines3 and Weights & Biases")
    print(f"Connecting to JavaScript bridge at {bridge_host}:{bridge_port}")
    
    # Install wandb if not already installed
    try:
        import wandb
    except ImportError:
        print("Weights & Biases not found. Installing...")
        import subprocess
        subprocess.check_call(["pip", "install", "wandb"])
        import wandb
    
    model = train_sb3_ppo(
        bridge_host=bridge_host,
        bridge_port=bridge_port,
        total_timesteps=100000,  # Adjust based on your needs
        save_path="minecraft_ppo_model"
    )