"""
Callbacks for Stable-Baselines3 integration with Weights & Biases
Provides logging functionality during training
"""

import numpy as np
import wandb
from stable_baselines3.common.callbacks import BaseCallback

class ParallelLoggingCallback(BaseCallback):
    """
    Custom callback for logging training progress with W&B integration for parallel environments
    """
    def __init__(self, verbose=0):
        """
        Initialize the callback
        
        Args:
            verbose (int): Verbosity level
        """
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
        """
        Called at each step of training
        
        Returns:
            bool: Whether training should continue
        """
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