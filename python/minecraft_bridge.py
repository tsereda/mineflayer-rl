"""
MinecraftBridge - Communication bridge between Python and JavaScript Mineflayer bots
Handles ZeroMQ messaging and provides an interface for the reinforcement learning agent
"""

import zmq
import time
import json
from typing import Dict, Any

class MinecraftBridge:
    """Bridge between Python and JavaScript Mineflayer bot using ZeroMQ"""
    def __init__(self, host="127.0.0.1", port=5555, timeout=60000, bot_id=0):
        """
        Initialize the bridge
        
        Args:
            host (str): Host where the JavaScript bridge is running
            port (int): Port for ZMQ communication
            timeout (int): Socket timeout in milliseconds
            bot_id (int): Unique identifier for this bot
        """
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
        """
        Make a request with automatic reconnection if needed
        
        Args:
            request_data (dict): Request data to send
            max_retries (int): Maximum number of retry attempts
            
        Returns:
            dict: Response from the JavaScript bridge
        """
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
        """
        Get current state from the JavaScript bot
        
        Returns:
            dict: Current state of the bot
        """
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
        """
        Send action to the JavaScript bot and get result
        
        Args:
            action (int): Action index to execute
            
        Returns:
            dict: Result containing reward, next state, and done flag
        """
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
        """
        Reset environment in the JavaScript bot
        
        Returns:
            dict: Initial state after reset
        """
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