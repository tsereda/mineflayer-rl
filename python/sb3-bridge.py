"""
Parallelized PPO implementation using Stable-Baselines3 with JavaScript Mineflayer bots
With Weights & Biases integration for improved monitoring
"""

import json
import time
import numpy as np
import gymnasium as gym
from gymnasium import spaces
import zmq
import argparse
from typing import Dict, Any, Tuple, List, Optional

# Import Stable-Baselines3
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import SubprocVecEnv
from stable_baselines3.common.monitor import Monitor

# Import Weights & Biases
import wandb
from wandb.integration.sb3 import WandbCallback

class MinecraftBridge:
    """Bridge between Python and JavaScript Mineflayer bot using ZeroMQ"""
    def __init__(self, host="127.0.0.1", port=5555, timeout=60000, bot_id=0):
        self.bot_id = bot_id
        self.host = host
        self.port = port
        self.timeout = timeout
        self.reconnect()
    
    def reconnect(self):
        """Create a fresh socket connection"""
        # Close existing connection if any
        if hasattr(self, 'socket') and self.socket:
            try:
                self.socket.close()
            except:
                pass
        if hasattr(self, 'context') and self.context:
            try:
                self.context.term()
            except:
                pass
                
        # Initialize ZeroMQ connection
        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.REQ)
        self.socket.connect(f"tcp://{self.host}:{self.port}")
        self.socket.setsockopt(zmq.RCVTIMEO, self.timeout)
        self.socket.setsockopt(zmq.LINGER, 0)  # Don't wait on close
        self.print_log(f"Connected to JavaScript bridge at {self.host}:{self.port}")
        
    def print_log(self, message):
        """Helper to log messages with bot ID prefix"""
        print(f"[Bot-{self.bot_id}] {message}")
    
    def safe_request(self, request_data, max_retries=2):
        """Make a request with automatic reconnection if needed"""
        for attempt in range(max_retries):
            try:
                self.socket.send_json(request_data)
                response = self.socket.recv_json()
                return response
            except zmq.error.Again:
                self.print_log(f"Timeout on attempt {attempt+1}/{max_retries}")
                # Only reconnect if it's not our last attempt
                if attempt < max_retries - 1:
                    self.print_log("Reconnecting...")
                    time.sleep(1)
                    self.reconnect()
            except zmq.error.ZMQError as e:
                self.print_log(f"ZMQ error: {e}. Reconnecting...")
                time.sleep(1)
                self.reconnect()
                
        self.print_log("All retries failed")
        return {"status": "error", "message": "All retries failed"}
    
    def get_state(self) -> Dict[str, Any]:
        """Get current state from the JS bot"""
        response = self.safe_request({"type": "get_state"})
        if response["status"] != "ok":
            # Return a default empty state on error
            self.print_log(f"Error getting state: {response.get('message', 'Unknown error')}")
            return {
                "position": {"x": 0, "y": 0, "z": 0},
                "yaw": 0, "pitch": 0,
                "inventory_logs": 0,
                "tree_visible": False,
                "closest_log": None
            }
        return response["state"]
    
    def take_action(self, action: int) -> Dict[str, Any]:
        """Send action to the JS bot and get result"""
        response = self.safe_request({"type": "take_action", "action": int(action)})
        if response["status"] != "ok":
            self.print_log(f"Error taking action: {response.get('message', 'Unknown error')}")
            return {
                "reward": -1.0,
                "next_state": self.get_state(),
                "done": True
            }
        return {
            "reward": response["reward"],
            "next_state": response["next_state"],
            "done": response["done"]
        }
    
    def reset(self) -> Dict[str, Any]:
        """Reset environment in the JS bot"""
        response = self.safe_request({"type": "reset"})
        if response["status"] != "ok":
            self.print_log(f"Error resetting: {response.get('message', 'Unknown error')}")
            # Try to get state anyway
            try:
                return self.get_state()
            except:
                # Return default state if all else fails
                return {
                    "position": {"x": 0, "y": 0, "z": 0},
                    "yaw": 0, "pitch": 0, 
                    "inventory_logs": 0,
                    "tree_visible": False,
                    "closest_log": None
                }
        return response["state"]
    
    def close(self):
        """Close the ZeroMQ connection"""
        try:
            # Send close message to JavaScript side
            try:
                self.safe_request({"type": "close"})
            except:
                pass  # It's ok if this fails
            
            self.socket.close()
            self.context.term()
            self.print_log("Connection closed")
        except Exception as e:
            self.print_log(f"Error closing connection: {e}")

class MinecraftEnv(gym.Env):
    """
    Custom Gym environment that interfaces with Mineflayer bot via ZeroMQ bridge
    """
    metadata = {'render.modes': ['human']}
    
    def __init__(self, bridge_host="127.0.0.1", bridge_port=5555, bot_id=0):
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

class ParallelLoggingCallback(BaseCallback):
    """
    Custom callback for logging training progress with W&B integration for parallel environments
    """
    def __init__(self, verbose=0):
        super(ParallelLoggingCallback, self).__init__(verbose)
        self.episode_rewards = []
        self.episode_lengths = []
        self.current_episode_rewards = None
        self.logs_collected = None
        self.bot_logs = None
    
    def _on_training_start(self) -> None:
        """Initialize tracking arrays based on number of environments"""
        num_envs = self.model.n_envs
        self.current_episode_rewards = np.zeros(num_envs)
        self.logs_collected = np.zeros(num_envs)
        self.bot_logs = [[] for _ in range(num_envs)]
    
    def _on_step(self) -> bool:
        """Called at each step of training"""
        # Update rewards for each environment
        for i, reward in enumerate(self.locals['rewards']):
            self.current_episode_rewards[i] += reward
            
            # Get logs collected if available
            if 'infos' in self.locals and len(self.locals['infos']) > i:
                if 'logs_collected' in self.locals['infos'][i]:
                    self.logs_collected[i] = self.locals['infos'][i]['logs_collected']
                    
                    # Record bot ID for logging
                    if 'bot_id' in self.locals['infos'][i]:
                        bot_id = self.locals['infos'][i]['bot_id']
                        self.bot_logs[i] = f"Bot-{bot_id}"
        
        # Log to W&B every 20 steps
        if self.num_timesteps % 20 == 0:
            # Log aggregate statistics
            wandb.log({
                "train/total_logs_collected": np.sum(self.logs_collected),
                "train/avg_episode_reward": np.mean(self.current_episode_rewards),
                "train/timestep": self.num_timesteps
            }, step=self.num_timesteps)
            
            # Log individual bot statistics
            for i in range(len(self.current_episode_rewards)):
                bot_name = self.bot_logs[i] if self.bot_logs[i] else f"Bot-{i}"
                wandb.log({
                    f"{bot_name}/reward": self.current_episode_rewards[i],
                    f"{bot_name}/logs_collected": self.logs_collected[i]
                }, step=self.num_timesteps)
        
        # Check for episode end in each environment
        for i, done in enumerate(self.locals['dones']):
            if done:
                # Record episode stats
                self.episode_rewards.append(self.current_episode_rewards[i])
                
                # Calculate average reward
                avg_reward = np.mean(self.episode_rewards[-10:]) if len(self.episode_rewards) >= 10 else np.mean(self.episode_rewards)
                
                # Log bot-specific episode completion
                bot_name = self.bot_logs[i] if self.bot_logs[i] else f"Bot-{i}"
                wandb.log({
                    f"episode/{bot_name}/reward": self.current_episode_rewards[i],
                    f"episode/{bot_name}/logs_collected": self.logs_collected[i],
                    f"episode/{bot_name}/avg_reward_10": avg_reward
                }, step=self.num_timesteps)
                
                # Print episode summary
                print(f"Episode complete for {bot_name}")
                print(f"  Reward: {self.current_episode_rewards[i]:.2f}")
                print(f"  Logs Collected: {self.logs_collected[i]}")
                
                # Reset this environment's episode tracking
                self.current_episode_rewards[i] = 0
        
        return True

def make_env(bridge_host="127.0.0.1", start_port=5555, bot_id=0):
    """Create a wrapped environment for Stable-Baselines3"""
    def _init():
        env = MinecraftEnv(bridge_host=bridge_host, bridge_port=start_port + bot_id, bot_id=bot_id)
        # Wrap with Monitor for logging episode stats
        return Monitor(env)
    return _init

def make_parallel_envs(num_envs=3, bridge_host="127.0.0.1", start_port=5555):
    """Create multiple environments for parallel training"""
    env_fns = [make_env(bridge_host=bridge_host, start_port=start_port, bot_id=i) for i in range(num_envs)]
    return SubprocVecEnv(env_fns)

def train_parallel_ppo(
    num_envs=3,
    bridge_host="127.0.0.1", 
    start_port=5555, 
    total_timesteps=100000,
    save_path="minecraft_ppo_parallel",
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
    Train a PPO agent using multiple parallel environments
    """
    # Initialize wandb
    run = wandb.init(
        project="minecraft-rl-parallel",
        config={
            "algorithm": "PPO",
            "environment": "Minecraft-Tree-Cutting",
            "num_envs": num_envs,
            "learning_rate": learning_rate,
            "n_steps": n_steps,
            "batch_size": batch_size,
            "n_epochs": n_epochs,
            "gamma": gamma,
            "gae_lambda": gae_lambda,
            "clip_range": clip_range,
            "bridge_host": bridge_host,
            "start_port": start_port
        }
    )
    
    # Create vectorized environment
    print(f"Creating {num_envs} parallel environments...")
    env = make_parallel_envs(
        num_envs=num_envs,
        bridge_host=bridge_host,
        start_port=start_port
    )
    
    # Create PPO model
    print("Initializing PPO model...")
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
    logging_callback = ParallelLoggingCallback()
    wandb_callback = WandbCallback(
        verbose=2,
        model_save_path=f"models/{run.id}",
        model_save_freq=5000,
        gradient_save_freq=0  # Disable gradient saving to reduce overhead
    )
    
    try:
        # Train the model with both callbacks
        print(f"Starting training with {num_envs} parallel environments for {total_timesteps} timesteps...")
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
    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Train PPO on multiple Minecraft bots in parallel")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host where JavaScript bridge is running")
    parser.add_argument("--port", type=int, default=5555, help="Base port for ZMQ communication")
    parser.add_argument("--num-bots", type=int, default=3, help="Number of bots to run in parallel")
    parser.add_argument("--timesteps", type=int, default=100000, help="Total timesteps to train")
    
    args = parser.parse_args()
    
    print(f"Training PPO agent with {args.num_bots} parallel bots")
    print(f"Connecting to JavaScript bridge at {args.host} starting at port {args.port}")
    
    # Install wandb if not already installed
    try:
        import wandb
    except ImportError:
        print("Weights & Biases not found. Installing...")
        import subprocess
        subprocess.check_call(["pip", "install", "wandb"])
        import wandb
    
    model = train_parallel_ppo(
        num_envs=args.num_bots,
        bridge_host=args.host,
        start_port=args.port,
        total_timesteps=args.timesteps,
        save_path="minecraft_ppo_parallel"
    )