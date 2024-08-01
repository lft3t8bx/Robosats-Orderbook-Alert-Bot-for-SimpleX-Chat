const sqlite3 = require("sqlite3").verbose()
const {exec} = require("child_process")
const {ChatClient} = require("..")
const {ChatType, ChatCommand} = require("../dist/command")
const {ciContentText, ChatInfoType} = require("../dist/response")
const schedule = require("node-schedule")

const Bottleneck = require("bottleneck")
const requestHandlerLimiter = new Bottleneck({
  // up to x requests
  maxConcurrent: 1000,

  // per y milliseconds
  minTime: 50,
})

const DATABASE_PATH = "data/alert.db"
const CHECK_NOTIFICATION_INTERVAL = 60000

const fs = require('fs');
const path = require('path');

let currencyCodes = {};
try {
    const currencyData = fs.readFileSync(path.join(__dirname, 'data', 'currency.json'), 'utf8');
    currencyCodes = JSON.parse(currencyData);
} catch (error) {
    console.error("Failed to load currency codes:", error);
}

let userSessions = {}
let userTimeouts = {}

async function run() {
  console.log("Starting the program...")
  const chat = await ChatClient.create("ws://localhost:5225")
  const user = await chat.apiGetActiveUser()
  if (!user) {
    console.log("Bot user profile not found. Ensure the bot is properly set up.")
    return
  }

  const address = (await chat.apiGetUserAddress()) || (await chat.apiCreateUserAddress())
  console.log(`Bot address: ${address}`)
  await chat.enableAddressAutoAccept()
  console.log("Bot is set to automatically accept contact requests.")

  processMessages(chat)
  startNotificationChecker(chat)
  scheduleAlertCheck(chat) // Correctly placed to schedule the alert check for disabling old alerts
}

async function startNotificationChecker(chat) {
  setInterval(() => {
    console.log("Triggering checkAndSendNotifications inside setInterval callback...")
    checkAndSendNotifications(chat)
  }, CHECK_NOTIFICATION_INTERVAL)
}

async function sendNotification(chat, userId, message, notificationId) {
  console.log(`Preparing to send notification ${notificationId} to user ${userId}`)
  return requestHandlerLimiter.schedule(() =>
    chat
      .apiSendTextMessage(ChatType.Direct, userId, message)
      .then(() => {
        console.log(`Notification ${notificationId} sent successfully.`)
        markNotificationAsSent(notificationId)
      })
      .catch((error) => {
        console.log(`Failed to send notification ${notificationId} to user ${userId}`, error.message)
        retryNotification(chat, userId, message, notificationId, error)
      })
  )
}

async function processMessages(chat) {
  console.log("Entering message processing loop...")
  for await (const message of chat.msgQ) {
    const response = message instanceof Promise ? await message : message
    console.log(`Received response type: ${response.type}`)
    let userId,
      commandRecognized = false

    // Handle new contact connections
    if (response.type === "contactConnected") {
      const {contact} = response
      console.log(`${contact.profile.displayName} connected`)
      await chat.apiSendTextMessage(
        ChatType.Direct,
        contact.contactId,
        "🤖 *Welcome to the Simplex Robosats alert bot!* 🚀 This bot will notify you 📬 every time an order that matches your requirements is posted on Robosats. To get started, please type `/help` for a list of commands you can use. 🛠️\n\nCreated by 🏛️ TempleOfSats 🏛️"
      )
      continue // Skip further processing for this iteration
    }

    // Process messages if the type is newChatItem
    if (response.type === "newChatItem") {
      if (response.chatItem.chatInfo.type === ChatInfoType.Direct) {
        userId = response.chatItem.chatInfo.contact.contactId
        const rawContent = response.chatItem.chatItem.content ? ciContentText(response.chatItem.chatItem.content) : null
        const textContent = typeof rawContent === "string" ? rawContent.trim() : ""

        // Skip processing if message is empty
        if (!textContent) {
          continue // Skip to the next iteration of the loop if the message is empty
        }

        console.log(`Message from ${userId}: ${textContent}`)
        if (textContent) {
          try {
            commandRecognized = await handleUserMessage(userId, textContent, chat)
          } catch (error) {
            if (error instanceof ChatCommandError) {
              console.error(`Encountered a chat command error: ${error.message}`)
              // Handle specific error types, e.g., contactNotReady
              if (error.response?.chatError?.errorType?.type === "contactNotReady") {
                console.log(`Contact not ready for message: ${error.response.chatError.errorType.contact.contactId}`)
                // Implement any specific logic here, such as retrying later or logging the issue
                continue // Skip further processing for this iteration
              }
            } else {
              // Handle other types of errors
              throw error // Or handle it as appropriate
            }
          }
        }
      }
    }

    // Send "Unrecognized command" message if the command is not recognized
    if (userId && !userSessions[userId] && !commandRecognized) {
      await chat.apiSendTextMessage(
        ChatType.Direct,
        userId,
        "🤖🚨 Oops! I didn't catch that. Looks like you've entered an unrecognized command. No worries! Type `/help` for a list of commands!"
      )
    }
  }
}

async function handleUserMessage(userId, text, chat) {
  console.log("Handling user message...")
  let status = userSessions[userId]?.status

  if (text === "/new" || userSessions[userId]) {
    clearTimeout(userTimeouts[userId])
    userTimeouts[userId] = setTimeout(() => {
      console.log(`User ${userId} timeout.`)
      delete userSessions[userId]
      delete userTimeouts[userId]
    }, 600000)
  }

  // add more commands here
  if (text === "/list") {
    console.log("Listing alerts...")
    await listAlerts(userId, chat)
    return true
  }
  if (text.startsWith("/disable ")) {
    console.log("Disable alert...")
    await disableAlert(userId, text.split(" ")[1], chat)
    return true
  }
  if (text === "/disableall") {
    console.log("Disabling all alerts...")
    await disableAllAlerts(userId, chat)
    return true
  }
  if (text.startsWith("/enable ")) {
    console.log("Enable alert...")
    await enableAlert(userId, text.split(" ")[1], chat)
    return true
  }

  if (text === "/enableall") {
    console.log("Enabling all alerts...")
    await enableAllAlerts(userId, chat)
    return true
  }

  if (text.startsWith("/extend ")) {
    console.log("Extending alert expiry...")
    const [command, alertId, days] = text.split(" ")
    if (alertId && days && !isNaN(days)) {
      extendAlertExpiry(userId, alertId, parseInt(days), chat)
    } else {
      chat.apiSendTextMessage(ChatType.Direct, userId, "Invalid command format. Use /extend <alert id> <number of days>.")
    }
    return true
  }

  if (text === "/satoshi") {
    getRandomQuote((message) => {
        chat.apiSendTextMessage(ChatType.Direct, userId, message);
    });
    return true; // Ensure to return true to stop further processing
  }

  if (text === "/help") {
    console.log("Help...")
    await showHelp(userId, chat)
    return true
  }

  if (text.startsWith("/remove ")) {
    console.log("Remove alert command detected...");
    const alertId = text.split(" ")[1];
    if (alertId && !isNaN(alertId)) { // Make sure alertId is a number
        await removeAlert(userId, alertId, chat);
    } else {
        chat.apiSendTextMessage(ChatType.Direct, userId, "Please provide a valid alert ID.");
    }
    return true;
}

  if (text === "/new") {
    console.log("New user session.")
    userSessions[userId] = {step: "action"}
    await chat.apiSendTextMessage(
      ChatType.Direct,
      userId,
      "🔄 Do you want to BUY 💸 or SELL 💰? Please type `BUY` or `SELL` to choose your action. 🚀"
    )
    return true
  }
  const session = userSessions[userId]
  if (!session) {
    return false
  }

  switch (session.step) {
    case "action":
      if (text.toUpperCase() === "BUY" || text.toUpperCase() === "SELL") {
        session.action = text.toUpperCase()
        session.step = "currency"
        await chat.apiSendTextMessage(
          ChatType.Direct,
          userId,
          "🌍 What is your fiat currency? (e.g., `USD`, `EUR`) Type the currency code to continue. Or you can type 'any' to avoid filtering by currency. This can be useful for trades that involves payment method compatible with multiple currencies (like Wise, Revolut, USDT ...) 💱"
        )
      } else {
        await chat.apiSendTextMessage(ChatType.Direct, userId, "Invalid option. Please type BUY or SELL.")
      }
      break
      case "currency":
        const normalizedInput = text.trim().toUpperCase(); // Normalize the input
      
        // Check if the input is "ANY" or a valid currency code
        if (normalizedInput === "ANY" || Object.values(currencyCodes).includes(normalizedInput)) {
          session.currency = normalizedInput; // Store "ANY" or the valid currency code
          session.step = "premium"; // Move to the next step
          await chat.apiSendTextMessage(
            ChatType.Direct,
            userId,
            "💼 What is the premium you're willing to buy/sell for (as a percentage)? Type the maximum premium if buying, minimum if selling. (e.g., 10)"
          );
        } else {
          // If the currency is neither "ANY" nor a valid code, ask again
          await chat.apiSendTextMessage(
            ChatType.Direct,
            userId,
            "🌍 The currency code you entered is not recognized. Please enter 'ANY' or a valid currency code. (e.g., USD, EUR)"
          );
        }
      break
      case "premium":
      if (!isNaN(text)) {
        // Removed the >= 0 condition to allow negative numbers
        session.premium = parseFloat(text)
        session.step = "payment_method"
        await chat.apiSendTextMessage(
          ChatType.Direct,
          userId,
          "💳 What payment method do you accept? Type your preferred method. if you allow multiple methods separate them by ',' . (i.e. paypal,sepa,revolut) Or type `Any` 🔄"
        )
      } else {
        await chat.apiSendTextMessage(ChatType.Direct, userId, "Please enter a valid number for premium.")
      }
      break
    case "payment_method":
      session.payment_method = text
      session.step = "amount"
      await chat.apiSendTextMessage(
        ChatType.Direct,
        userId,
        "💰 Please specify your minimum and maximum amount by entering it in the following format: `min-max`. For example, `100-500`. If there's no limit, type `ANY` for either min, max or both. This will help us match you with the perfect orders! 📊"
      )
      // explain the format as you mentioned
      break
    case "amount":
        // Trim the input to remove leading/trailing spaces
      const trimmedInput = text.trim();
      
        // Split the input based on the hyphen and trim parts
      const parts = trimmedInput.split('-').map(part => part.trim());
      
        // Check if parts length is 2 and both parts are either numbers or "ANY"
      const isValidInput = parts.length === 2 && parts.every(part => !isNaN(part) || part.toUpperCase() === "ANY");
      
      if (!isValidInput) {
          // If input is not valid, prompt the user to use the correct format
        await chat.apiSendTextMessage(
          ChatType.Direct,
          userId,
          "💡 Please ensure you use the correct format with a hyphen between the minimum and maximum amounts, like `100-500` or `ANY-ANY`. Spaces around the hyphen are okay. Try again:"
        );
        return true; // Return true to indicate a command was recognized but needs correction
        }
      
        // Proceed with parsing and handling the correctly formatted input
      session.min_amount = parts[0].toUpperCase() === "ANY" ? 0 : parseFloat(parts[0]);
      session.max_amount = parts[1].toUpperCase() === "ANY" ? Infinity : parseFloat(parts[1]);
      
      completeAlertCreation(userId, session, chat);
      break;
    default:
      await chat.apiSendTextMessage(
        ChatType.Direct,
        userId,
        "🤖🚨 Oops! I didn't catch that. Looks like you've entered an unrecognized command. No worries! Type `/help` for a list of commands!"
      )
      return
  }
  clearTimeout(userTimeouts[userId])
  delete userTimeouts[userId]
}

async function removeAlert(userId, alertId, chat) {
  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (err) => {
      if (err) {
          console.error("Error opening database", err);
          chat.apiSendTextMessage(ChatType.Direct, userId, "⚠️ Database error occurred.");
          return;
      }
  });

  db.get(`SELECT * FROM alerts WHERE user_id = ? AND alert_id = ?`, [userId, alertId], (err, row) => {
      if (err) {
          chat.apiSendTextMessage(ChatType.Direct, userId, "Failed to find the alert.");
          db.close();
      } else if (!row) {
          chat.apiSendTextMessage(ChatType.Direct, userId, `Alert ID ${alertId} not found.`);
          db.close();
      } else {
          db.run(`DELETE FROM alerts WHERE user_id = ? AND alert_id = ?`, [userId, alertId], function (err) {
              if (err) {
                  chat.apiSendTextMessage(ChatType.Direct, userId, "Error removing the alert.");
              } else {
                  chat.apiSendTextMessage(ChatType.Direct, userId, `Alert ID ${alertId} has been successfully removed.`);
              }
              db.close();
          });
      }
  });
}


async function listAlerts(userId, chat, is_active) {
  let sql
  if (is_active !== undefined) {
    sql = `SELECT * FROM alerts WHERE user_id = ${userId} AND is_active = ${is_active}`
  } else {
    sql = `SELECT * FROM alerts WHERE user_id = ${userId}`
  }

  const promiseCallback = (resolve, reject) => {
    let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READONLY, (err) => {
      if (err) reject("Error opening database")
    })

    db.all(sql, (err, rows) => {
      if (err) reject("Error running sql")
      else {
        if (rows && rows.length > 0) {
          let msg = "Here are your alerts:\n"
          rows.forEach((row) => {
            const statusIcon = row.is_active === 1 ? "✅" : "🔴";
            const statusText = row.is_active === 1 ? "*ACTIVE*" : "*DISABLED*";
            msg += `${statusIcon} *Alert Id: ${row.alert_id}*\n` +
                   `Action: ${row.action}\n` +
                   `Currency: ${row.currency}\n` +
                   `Premium: ${row.premium}\n` +
                   `Min Amount: ${row.min_amount}, Max Amount: ${row.max_amount}\n` +
                   `Payment Methods: ${row.payment_method}\n` +
                   `Status: ${statusText}\n\n`;
          })
          chat.apiSendTextMessage(ChatType.Direct, userId, msg)
        } else {
          chat.apiSendTextMessage(ChatType.Direct, userId, "No alerts found.")
        }
      }
      resolve(rows)
    })

    db.close((err) => {
      if (err) reject("Error closing database")
    })
  }

  const result = await new Promise(promiseCallback)
}

async function disableAlert(userId, alertId, chat) {
  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      console.error("Error opening database", err)
      return
    }
  })

  db.get(`SELECT is_active FROM alerts WHERE user_id = ? AND alert_id = ?`, [userId, alertId], (err, row) => {
    if (err) {
      chat.apiSendTextMessage(ChatType.Direct, userId, "Failed to query the alert status.")
      db.close()
    } else if (!row) {
      chat.apiSendTextMessage(ChatType.Direct, userId, `Alert ID ${alertId} not found.`)
      db.close()
    } else if (row.is_active === 0) {
      chat.apiSendTextMessage(ChatType.Direct, userId, `Alert ID ${alertId} is already disabled.`)
      db.close()
    } else {
      db.run(`UPDATE alerts SET is_active = 0 WHERE user_id = ? AND alert_id = ?`, [userId, alertId], function (err) {
        if (err) {
          chat.apiSendTextMessage(ChatType.Direct, userId, "⚠️ Oops! There was an error disabling the alert.")
        } else {
          chat.apiSendTextMessage(
            ChatType.Direct,
            userId,
            `✅ Alert ID ${alertId} has been successfully disabled. You won't receive notifications for this alert until you enable it again with /enable ${alertId}. 🔕`
          )
        }
        db.close()
      })
    }
  })
}

async function disableAllAlerts(userId, chat) {
  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      chat.apiSendTextMessage(ChatType.Direct, userId, "Error opening database for disabling all alerts.")
      return
    }
  })

  db.run(`UPDATE alerts SET is_active = 0 WHERE user_id = ? AND is_active = 1`, [userId], function (err) {
    if (err) {
      chat.apiSendTextMessage(ChatType.Direct, userId, "Error disabling all alerts.")
    } else if (this.changes > 0) {
      chat.apiSendTextMessage(ChatType.Direct, userId, "All alerts have been disabled successfully.")
    } else {
      chat.apiSendTextMessage(ChatType.Direct, userId, "No enabled alerts found to disable.")
    }
    db.close()
  })
}
async function enableAlert(userId, alertId, chat) {
  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      console.error("Error opening database", err)
      return
    }
  })

  db.get(`SELECT is_active FROM alerts WHERE user_id = ? AND alert_id = ?`, [userId, alertId], (err, row) => {
    if (err) {
      chat.apiSendTextMessage(ChatType.Direct, userId, "Failed to query the alert status.")
      db.close()
    } else if (!row) {
      chat.apiSendTextMessage(ChatType.Direct, userId, `Alert ID ${alertId} not found.`)
      db.close()
    } else if (row.is_active === 1) {
      chat.apiSendTextMessage(ChatType.Direct, userId, `Alert ID ${alertId} is already enabled.`)
      db.close()
    } else {
      db.run(`UPDATE alerts SET is_active = 1 WHERE user_id = ? AND alert_id = ?`, [userId, alertId], function (err) {
        if (err) {
          chat.apiSendTextMessage(ChatType.Direct, userId, "Error enabling the alert.")
        } else {
          chat.apiSendTextMessage(ChatType.Direct, userId, `Alert ID ${alertId} enabled successfully.`)
        }
        db.close()
      })
    }
  })
}

async function showHelp(userId, chat) {
  const helpMessage = `🤖 Here's how you can interact with me, your friendly Robosats Alert Bot:


    */new* 🆕: Create a new alert!

    */list* 📝: List all your alerts

    */disable <alert id>* 🔕: Mute any alert. Use /list to check your alert id.
    For example, to disable an alert with ID 10, you would type /disable 10.

    */disableall* 🔕: Take a break and mute all alerts at once.

    */enable <alert id>* 🔔: reenable an alert.

    */enableall* 🔔: reenable all alerts.

    */remove <alert id>* 🗑️: remove the selected alert from the databse.

    */extend <alert id> <number of days>* : Extend the life of an alert. 
    For example, '/extend 10 30' would extend alert ID 10 by 30 days from current date. By default all alerts have a 7 days lifetime. After that they will be disabled but you can always reenabled them.
    
    The script is design to be forgiving to formatting (it is case and white space insensitive)`

  chat.apiSendTextMessage(ChatType.Direct, userId, helpMessage)
}

async function enableAllAlerts(userId, chat) {
  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      chat.apiSendTextMessage(ChatType.Direct, userId, "Error opening database for enabling all alerts.")
      return
    }
  })

  db.run(`UPDATE alerts SET is_active = 1 WHERE user_id = ? AND is_active = 0`, [userId], function (err) {
    if (err) {
      chat.apiSendTextMessage(ChatType.Direct, userId, "⚠️ Error enabling all alerts.")
    } else if (this.changes > 0) {
      chat.apiSendTextMessage(ChatType.Direct, userId, "✅ All alerts have been enabled successfully.")
    } else {
      chat.apiSendTextMessage(ChatType.Direct, userId, "⚠️ No disabled alerts found to enable.")
    }
    db.close()
  })
}

async function completeAlertCreation(userId, session, chat) {
  console.log("Completing alert creation...")

  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      console.error("Error opening database", err.message)
      return
    }
  })

  const insertSql = `INSERT INTO alerts (user_id, action, currency, premium, payment_method, min_amount, max_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`

  db.run(
    insertSql,
    [userId, session.action, session.currency, session.premium, session.payment_method, session.min_amount, session.max_amount],
    function (err) {
      if (err) {
        console.error("Error inserting alert into database", err.message)
        chat.apiSendTextMessage(ChatType.Direct, userId, "⚠️ Failed to create alert due to an error.")
      } else {
        console.log(`New alert inserted with rowid ${this.lastID}`)
        chat.apiSendTextMessage(
          ChatType.Direct,
          userId,
          `⚡ Your alert is confirmed as follows!  
          
          ・Orders for you to ${session.action}  
          ・Currency: ${session.currency}
          ・Premium of ${session.premium}%
          ・Payment methods: ${session.payment_method}
          ・Amount: ${session.min_amount}-${session.max_amount} 
          
          🚀 Keep an eye out for matching orders! 📈\n\nManage your alerts with /list, /enable, /disable, and /extend commands. Happy trading! 💼`
        )

        session.step = "completed"

        if (userTimeouts[userId]) {
          clearTimeout(userTimeouts[userId])
          delete userTimeouts[userId]
        }
      }
    }
  )

  db.close()
}

async function extendAlertExpiry(userId, alertId, days, chat) {
  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      console.error("Error opening database", err)
      return
    }
  })

  db.get(`SELECT * FROM alerts WHERE alert_id = ? AND user_id = ?`, [alertId, userId], (err, row) => {
    if (err) {
      chat.apiSendTextMessage(ChatType.Direct, userId, "⚠️ Failed to query the alert.")
      db.close()
    } else if (!row) {
      chat.apiSendTextMessage(ChatType.Direct, userId, `⚠️ Alert ID ${alertId} not found.`)
      db.close()
    } else {
      const newDate = new Date()
      newDate.setUTCDate(newDate.getUTCDate() + days)
      const formattedDate = formatDateToUTC(newDate)

      db.run(`UPDATE alerts SET created_at = ?, is_active = 1 WHERE alert_id = ?`, [formattedDate, alertId], function (err) {
        if (err) {
          chat.apiSendTextMessage(ChatType.Direct, userId, "⚠️Error extending the alert expiry.")
        } else {
          chat.apiSendTextMessage(
            ChatType.Direct,
            userId,
            `✅Alert ID ${alertId} expiry extended to ${formattedDate} successfully and is now enabled even if previously disabled.`
          )
        }
        db.close()
      })
    }
  })
}

async function markNotificationAsFailed(notificationId) {
  console.log("Marking notification as failed...")

  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      console.error("Error opening database", err.message)
      return
    }
  })

  const updateQuery = `UPDATE notifications SET sent = 2 WHERE notification_id = ?`
  db.run(updateQuery, [notificationId], (err) => {
    if (err) {
      console.error("Error marking notification as failed", err.message)
    } else {
      console.log(`Notification ${notificationId} marked as failed.`)
    }
  })

  db.close()
}

function formatDateToUTC(date) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  const hours = String(date.getUTCHours()).padStart(2, "0")
  const minutes = String(date.getUTCMinutes()).padStart(2, "0")
  const seconds = String(date.getUTCSeconds()).padStart(2, "0")
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function formatDate(date) {
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, "0")
  const day = date.getDate().toString().padStart(2, "0")
  const hours = date.getHours().toString().padStart(2, "0")
  const minutes = date.getMinutes().toString().padStart(2, "0")
  const seconds = date.getSeconds().toString().padStart(2, "0")
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function checkAndSendNotifications(chat) {
  console.log("Checking notifications...")

  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
      console.error("Error opening database", err.message)
      return
    }
  })

  const query = `SELECT notification_id, user_id, message FROM notifications WHERE sent = 0`
  console.log("Fetching unsent notifications...")
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error("Error querying notifications", err.message)
      return
    }

    console.log(`Found ${rows.length} unsent notifications.`)
    rows.forEach((row) => {
      console.log(`Preparing to send notification ${row.notification_id} to user ${row.user_id}`)
      sendNotification(chat, row.user_id, row.message, row.notification_id)
    })
  })

  db.close()
}

function retryNotification(chat, userId, message, notificationId, reason) {
  const retryCount = userSessions[userId]?.retryCount || 0
  if (retryCount >= 3) {
    console.error(`Notification failed after maximum retries, not retrying. ${notificationId} to user ${userId}`, reason)
    markNotificationAsFailed(notificationId) // marking notification as failed after max retries
    return
  }

  const backoffMs = 200 * Math.pow(2, retryCount)

  userSessions[userId] = {retryCount: retryCount + 1}

  setTimeout(() => {
    console.log(`Retrying notification ${notificationId} to user ${userId}...`)
    sendNotification(chat, userId, message, notificationId)
  }, backoffMs)
}

function markNotificationAsSent(notificationId) {
  console.log("Marking notification as sent...")

  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      console.error("Error opening database", err.message)
      return
    }
  })

  const updateQuery = `UPDATE notifications SET sent = 1 WHERE notification_id = ?`
  db.run(updateQuery, [notificationId], (err) => {
    if (err) {
      console.error("Error marking notification as sent", err.message)
    } else {
      console.log(`Notification ${notificationId} marked as sent.`)
    }
  })

  db.close()
}

function disableOldAlertsAndNotify(chat) {
  let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
      console.error("Error opening database", err.message)
      return;
    }
  });

  const aWeekAgo = new Date();
  aWeekAgo.setDate(aWeekAgo.getDate() - 7);

  const query = `SELECT * FROM alerts WHERE created_at < ? AND is_active = 1`;
  db.each(query, [aWeekAgo.toISOString()], (err, row) => {
    if (err) {
      console.error("Error querying old alerts", err.message);
    } else {
      db.run(`UPDATE alerts SET is_active = 0 WHERE alert_id = ?`, [row.alert_id], function (err) {
        if (err) {
          console.error("Error disabling alert", err.message);
        } else {
          const message = `🔔Your alert ${row.alert_id} "${row.message}" has expired🔕. You can re-enable it by sending "/enable ${row.alert_id}" or extend its expiry by sending "/extend ${row.alert_id} <number of days>". This is normal! By default, all alerts are disabled after 7 days.`;
          // Ensure chat is properly initialized and able to send messages
          if (chat && chat.apiSendTextMessage) {
            chat.apiSendTextMessage(ChatType.Direct, row.user_id, message).then(() => {
              console.log(`Notification sent successfully to user ${row.user_id} for alert ${row.alert_id}.`);
            }).catch((error) => {
              console.error(`Failed to send notification to user ${row.user_id} for alert ${row.alert_id}:`, error);
            });
          }
        }
      });
    }
  });

  db.close((err) => {
    if (err) {
      console.error("Error closing database", err);
    }
  });
}

function getRandomQuote(callback) {
  const quotesPath = path.join(__dirname, 'data', 'quotes.json');
  fs.readFile(quotesPath, 'utf8', (err, data) => {
      if (err) {
          console.error("Failed to load quotes:", err);
          callback("Sorry, I couldn't retrieve a quote at the moment.");
          return;
      }
      const quotes = JSON.parse(data).filter(q => q.medium && q.text && q.date);
      if (quotes.length === 0) {
          callback("Sorry, no quotes are available at the moment.");
          return;
      }
      const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
      const message = `*📜 Satoshi once said:* \n \n \n "${randomQuote.text}"\n \n ${randomQuote.medium}, ${randomQuote.date}`;
      callback(message);
  });
}

function scheduleAlertCheck(chat) {
  // Schedule to run daily at 5 pm
  schedule.scheduleJob("0 17 * * *", function () {
    console.log("Scheduled check for old alerts...")
    disableOldAlertsAndNotify(chat)
  })
}

run().catch(console.error)
