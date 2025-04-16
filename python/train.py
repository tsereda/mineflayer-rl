"""
Main training script for Minecraft RL agent using Stable-Baselines3 and Weights & Biases
"""

import argparse
import time
import wandb
from wandb.integration.sb3 import WandbCallback
from stable_baselines3 import PPO

from utils import make_parallel_envs
from callbacks import ParallelLoggingCallback

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
    
    Args:
        num_envs (int): Number of parallel environments
        bridge_host (str): Host where the JavaScript bridge is running
        start_port (int): Base port for ZMQ communication
        total_timesteps (int): Total timesteps for training
        save_path (str): Path to save the model
        learning_rate (float): Learning rate
        n_steps (int): Number of steps to run for each environment per update
        batch_size (int): Minibatch size
        n_epochs (int): Number of epochs when optimizing the surrogate loss
        gamma (float): Discount factor
        gae_lambda (float): Factor for trade-off of bias vs variance for Generalized Advantage Estimator
        clip_range (float): Clipping parameter for PPO
        verbose (int): Verbosity level
        
    Returns:
        PPO: Trained PPO model
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