# Robosats Alert Bot for SimpleX

## Overview

## Project Structure

Here's a brief overview of the key components in this project:

### JavaScript Files

- **`bot.js`**: The core of the chat bot, handling user interactions, processing commands, and managing user sessions. It establishes the WebSocket connection to the Simplex Chat server and listens for incoming messages to respond accordingly.

### Python Scripts

- **`matcher.py`**: This script processes user-defined alert criteria against a dynamic order book to find matches. When a match is found, it triggers notifications to be sent to the user through the chat bot.

- **`orderbook_downloader.py`**: Responsible for downloading the latest order book data from multiple sources. It saves this data locally to be processed by `matcher.py` for matching against user alerts.

### Data Files

- **`data/alert.db`**: A SQLite database file that stores user alerts, matches, and notification statuses. It is interacted with by both the chat bot and the matcher script.

- **`data/currency.json`**: Contains mapping of currency codes to currency names, used by the matcher script to validate and process user alerts based on currency preferences.

- **`data/federation.json`**: Holds information about different federations or sources from which order book data is fetched. Used by `orderbook_downloader.py` to identify sources.

- **`data/orderbook/`**: A directory containing JSON files with order book data downloaded by `orderbook_downloader.py`. Each file is named after its source and processed by `matcher.py`.

- **`data/quotes.json`**: Stores a collection of inspirational quotes. The chat bot can randomly select from these to send to users.

## Getting Started

### Prerequisites

- Node.js and npm
- Python 3.x
- SQLite3

### Installation

1. Clone the repository to your local machine.
2. Navigate to the project directory and install JavaScript dependencies:
   ```bash
   npm install
