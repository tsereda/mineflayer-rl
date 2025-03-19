# Mineflayer-RL Setup Guide

This guide will help you set up and run the Mineflayer-RL project on Windows.

## Prerequisites

Before you begin, you'll need to download and install the following:

1. **Git** - [Download Git for Windows](https://git-scm.com/downloads/win)
2. **NodeJS** - [Download NodeJS](https://nodejs.org/en/download/)
3. **Minecraft Java Edition** - [Download Minecraft Java Edition](https://www.minecraft.net/en-us/download) (Requires a Minecraft account)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/tsereda/mineflayer-rl.git
   ```

2. Navigate to the project directory:
   ```bash
   cd mineflayer-rl
   ```

## Finding Your IP Address

1. Press `Windows Key + R`, type `cmd`, and press Enter
2. In the command prompt, type `ipconfig`
3. Look for and record your IPv4 address (There may be several listed)

## Setting Up Minecraft

1. Run Minecraft: Java Edition 1.19
2. Select "Singleplayer" → "Create New World"
3. Set the following options:
   - Difficulty: Peaceful
   - Advanced Options → Seed: `treesplease`
   - Allow Cheats: ON
4. Click "Done" and then "Create New World"
5. Once the world loads, open to LAN:
   - Press Escape
   - Click "Open to LAN"
   - Click "Start LAN World"
6. Record the port number shown in the chat (or press 'T' to view chat again)

## Running the Bots

1. Navigate back to your mineflayer-rl folder
2. Run the following command, replacing `<SERVER_IP>` with your IPv4 address and `<PORT>` with the port number from Minecraft:
   ```bash
   node parallel-bots.js --ip <SERVER_IP> --port <PORT>
   ```

## Troubleshooting

If you encounter issues:
- Make sure you're using Minecraft Java Edition version 1.19
- Verify that your IP address and port are correct
- Check that NodeJS is properly installed
- Ask Tim
