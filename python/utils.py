"""
Utility functions for RL environment setup and parallel processing
"""

from stable_baselines3.common.vec_env import SubprocVecEnv
from stable_baselines3.common.monitor import Monitor
from minecraft_env import MinecraftEnv

def make_env(bridge_host="127.0.0.1", start_port=5555, bot_id=0):
    """
    Create a wrapped environment for Stable-Baselines3
    
    Args:
        bridge_host (str): Host where the JavaScript bridge is running
        start_port (int): Base port for ZMQ communication
        bot_id (int): Unique identifier for this bot
        
    Returns:
        callable: Function that creates and initializes the environment
    """
    def _init():
        env = MinecraftEnv(bridge_host=bridge_host, bridge_port=start_port + bot_id, bot_id=bot_id)
        # Wrap with Monitor for logging episode stats
        return Monitor(env)
    return _init

def make_parallel_envs(num_envs=3, bridge_host="127.0.0.1", start_port=5555):
    """
    Create multiple environments for parallel training
    
    Args:
        num_envs (int): Number of parallel environments
        bridge_host (str): Host where the JavaScript bridge is running
        start_port (int): Base port for ZMQ communication
        
    Returns:
        SubprocVecEnv: Vectorized environment with multiple parallel environments
    """
    env_fns = [make_env(bridge_host=bridge_host, start_port=start_port, bot_id=i) for i in range(num_envs)]
    return SubprocVecEnv(env_fns)