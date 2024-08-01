import requests
import json
import time
import os
import fcntl
import socks
import socket

ORDERBOOK_URLS = [
    'http://ngdk7ocdzmz5kzsysa3om6du7ycj2evxp2f2olfkyq37htx3gllwp2yd.onion/api/book/?format=json',
    'http://satstraoq35jffvkgpfoqld32nzw2siuvowanruindbfojowpwsjdgad.onion/api/book/?format=json',
    'http://4t4jxmivv6uqej6xzx2jx3fxh75gtt65v3szjoqmc4ugdlhipzdat6yd.onion/api/book/?format=json',
    'http://mmhaqzuirth5rx7gl24d4773lknltjhik57k7ahec5iefktezv4b3uid.onion/api/book/?format=json',
]

ORDERBOOK_DIR = 'data/orderbook'
DOWNLOAD_INTERVAL = 60  # in seconds

# Configure requests to use Tor SOCKS5 proxy
session = requests.session()
session.proxies = {
    'http': 'socks5h://127.0.0.1:9050',
    'https': 'socks5h://127.0.0.1:9050'
}

def download_orderbook(orderbook_url):
    """
    Downloads the current order book from given URL and returns it as a dictionary.
    """
    try:
        response = session.get(orderbook_url)
        response.raise_for_status()  # Raises a HTTPError if the response status code is 4XX/5XX
        return response.json()
    except requests.RequestException as e:
        print(f"Failed to download order book: {e}")
        return None

def save_orderbook(orderbook, orderbook_path):
    """
    Saves the order book to a local JSON file with a simple file lock.
    """
    with open(orderbook_path, 'w') as file:
        fcntl.flock(file.fileno(), fcntl.LOCK_EX)
        json.dump(orderbook, file, indent=4)

def remove_orderbook(orderbook_path):
    """
    Removes the specified order book JSON file if it exists.
    """
    if os.path.exists(orderbook_path):
        os.remove(orderbook_path)
        print(f"Removed previously saved order book: {orderbook_path}")

def main():
    if not os.path.exists(ORDERBOOK_DIR):
        os.makedirs(ORDERBOOK_DIR)

    while True:
        for orderbook_url in ORDERBOOK_URLS:
            print(f"Downloading order book from {orderbook_url}...")
            orderbook = download_orderbook(orderbook_url)
            filename = orderbook_url.split('//')[1].split('/')[0] + '.json'
            orderbook_path = os.path.join(ORDERBOOK_DIR, filename)
            
            if orderbook is not None:
                print(f"Saving order book to {orderbook_path}...")
                save_orderbook(orderbook, orderbook_path)
            else:
                print("Download failed, removing previously saved file if it exists.")
                remove_orderbook(orderbook_path)
        time.sleep(DOWNLOAD_INTERVAL)

if __name__ == "__main__":
    main()
