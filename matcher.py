import json
import sqlite3
import os
import glob
import time

DATABASE_PATH = 'data/alert.db'
CURRENCY_MAPPING_PATH = 'data/currency.json'
FEDERATION_PATH = 'data/federation.json'

def fetch_currency_mapping():
    try:
        with open(CURRENCY_MAPPING_PATH, 'r') as file:
            return json.load(file)
    except Exception as e:
        print(f"Error fetching currency mapping: {e}")
        return {}

def load_federation_data():
    try:
        with open(FEDERATION_PATH, 'r') as file:
            return json.load(file)
    except Exception as e:
        print(f"Error loading federation data: {e}")
        return {}

def find_coordinator_name(source, federation_data):
    source = source.replace("http://", "").replace("https://", "")
    
    for coordinator, data in federation_data.items():
        onion_url = data.get("mainnet", {}).get("onion", "")
        onion_url = onion_url.replace("http://", "").replace("https://", "")
        
        if onion_url == source:
            return data.get("longAlias", "")
    return ""

def normalize_payment_method(method):
    method = method.lower().replace(' ', '')
    return method

def find_matches(alert, order_book, currency_mapping):
    matches = []
    
    for order in order_book:
        currency_code = currency_mapping.get(str(order['currency']), None)
        
        if alert['currency'].upper() != "ANY" and currency_code != alert['currency']:
            print(f"Skipping order {order['id']} due to currency mismatch: Order currency {currency_code}, Alert currency {alert['currency']}")
            continue

        if (alert['action'].upper() == 'BUY' and order['type'] != 1) or (alert['action'].upper() == 'SELL' and order['type'] != 0):
            print(f"Skipping order {order['id']} due to action mismatch. Order action: {order['type']}, Alert action: {alert['action']}")
            continue

        # Check for premium match.
        # If Alert is SELL, Premium in OrderBook needs to be greater or equal
        # If Alert is BUY, Premium in OrderBook needs to be lower or equal
        order_premium = float(order['premium'])
        alert_premium = float(alert['premium'])
        if (alert['action'].upper() == 'SELL' and order_premium < alert_premium) or (alert['action'].upper() == 'BUY' and order_premium > alert_premium):
            print(f"Skipping order {order['id']} due to premium mismatch. Order premium: {order_premium}, Alert premium: {alert_premium}")
            continue
        
        alert_payment_methods = [normalize_payment_method(method) for method in alert['payment_method'].split(',')]
        bypass_payment_method_check = 'any' in alert_payment_methods

        if not bypass_payment_method_check:
            order_payment_method_normalized = normalize_payment_method(order['payment_method'])
            if not any(alert_method in order_payment_method_normalized for alert_method in alert_payment_methods):
                continue

        if order['has_range']:
            lower_min_amount = str(alert['min_amount']).lower().strip() if alert['min_amount'] is not None else None
            lower_max_amount = str(alert['max_amount']).lower().strip() if alert['max_amount'] is not None else None
            
            min_amount = float(order['min_amount']) if order['min_amount'] else None
            max_amount = float(order['max_amount']) if order['max_amount'] else None
            
            if lower_min_amount == 'any' and lower_max_amount == 'any':
                pass
            elif min_amount is not None and max_amount is not None:
                amount_match = not (float(alert['max_amount']) < min_amount or float(alert['min_amount']) > max_amount)
                print(f"Amount match for range order {order['id']} and alert {alert['alert_id']} is {amount_match}")
                if not amount_match:
                    continue
        else:
            if alert['min_amount'] is not None and alert['max_amount'] is not None and order.get('amount') is not None:
                amount_match = float(alert['min_amount']) <= float(order['amount']) <= float(alert['max_amount'])
                print(f"Amount match for single value order {order['id']} and alert {alert['alert_id']} is {amount_match}")
                if not amount_match:
                    continue

        matches.append(order)
    return matches

   
def notify_user(user_id, matches, alert, federation_data):
    with sqlite3.connect(DATABASE_PATH) as conn:
        cursor = conn.cursor()
        for match in matches:
            coordinator_name = find_coordinator_name(match['source'], federation_data)
            coordinator_msg = f"🤖 Coordinator: {coordinator_name}" if coordinator_name else ""

            existing_notification = cursor.execute("SELECT notification_id FROM notifications WHERE user_id = ? AND order_id = ?",
                                              (user_id, match['id'])).fetchone()


            if existing_notification:
                continue

            if match['has_range']:
                min_amt = str(match['min_amount']).rstrip('0').rstrip('.') if '.' in str(match['min_amount']) else str(match['min_amount'])
                max_amt = str(match['max_amount']).rstrip('0').rstrip('.') if '.' in str(match['max_amount']) else str(match['max_amount'])
                amount_display = f"{min_amt}-{max_amt}"
            else:
                # This ensures single value amounts are also formatted to remove trailing zeros
                amount_display = str(match['amount']).rstrip('0').rstrip('.') if '.' in str(match['amount']) else str(match['amount'])

            action = alert['action']
            currency_display = "Any Currency" if alert['currency'].upper() == "ANY" else alert['currency']
            message = f"*⚡ Match found! ⚡*\n \n For you to {action}\n \n・Order ID: {match['id']},\n・Premium: {match['premium']}%,\n・Payment Method: {match['payment_method']},\n・Amount: {amount_display} {currency_display},\n \n🌍 http://{match['source']}/order/{match['id']}\n \n{coordinator_msg}"
            cursor.execute("INSERT INTO notifications (user_id, order_id, message, sent) VALUES (?, ?, ?, 0)", (user_id, match['id'], message))


        conn.commit()

def main(user_id, alert_json, federation_data):
    alert = json.loads(alert_json)
    orderbooks = glob.glob('data/orderbook/*.json')
    for orderbook_file in orderbooks:
        with open(orderbook_file) as f:
            order_book = json.load(f)
        source = os.path.splitext(os.path.basename(orderbook_file))[0]
        currency_mapping = fetch_currency_mapping()
        matches = find_matches(alert, order_book, currency_mapping)
        if matches:
            for match in matches:
                match['source'] = source
            notify_user(user_id, matches, alert, federation_data)  
            print(f"Matches found and notifications saved for user ID {user_id}.")
        else:
            print("No matches found.")

if __name__ == "__main__":
    federation_data = load_federation_data()  

    while True:
        with sqlite3.connect(DATABASE_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT alert_id, user_id, action, currency, premium, payment_method, min_amount, max_amount FROM alerts WHERE is_active = 1")
            alerts = cursor.fetchall()

        for alert in alerts:
            alert_dict = {
                "alert_id": alert[0],
                "action": alert[2],
                "currency": alert[3],
                "premium": alert[4],
                "payment_method": alert[5],
                "min_amount": alert[6],
                "max_amount": alert[7],
            }

            main(alert[1], json.dumps(alert_dict), federation_data) 

        time.sleep(120)