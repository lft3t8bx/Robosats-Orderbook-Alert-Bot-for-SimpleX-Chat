import sqlite3
import os
from datetime import datetime, timedelta

DATABASE_PATH = 'data/alert.db'

def remove_old_disabled_alerts():
    try:
        conn = sqlite3.connect(DATABASE_PATH)
        cursor = conn.cursor()

        fourteen_days_ago = datetime.utcnow() - timedelta(days=14)
        cursor.execute("DELETE FROM alerts WHERE is_active = 0 AND created_at < ?", (fourteen_days_ago.isoformat(),))
        removed_alerts = cursor.rowcount
        conn.commit()
        print(f"Removed {removed_alerts} old disabled alerts.")
    except sqlite3.Error as e:
        print(f"Error removing old disabled alerts: {e}")
    finally:
        if conn:
            conn.close()

def remove_old_notifications():
    try:
        conn = sqlite3.connect(DATABASE_PATH)
        cursor = conn.cursor()

        seven_days_ago = datetime.utcnow() - timedelta(days=7)
        cursor.execute("DELETE FROM notifications WHERE created_at < ?", (seven_days_ago.isoformat(),))
        removed_notifications = cursor.rowcount
        conn.commit()
        print(f"Removed {removed_notifications} old notifications.")
    except sqlite3.Error as e:
        print(f"Error removing old notifications: {e}")
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    remove_old_disabled_alerts()
    remove_old_notifications()
