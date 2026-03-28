⚡ DAYWORK SERVER
=================

REQUIREMENTS
------------
Node.js must be installed on your computer.
Download free at: https://nodejs.org  (get the LTS version)


HOW TO START
------------
Windows:   Double-click START.bat
Mac/Linux: Open Terminal, type:  bash START.sh


OPEN THE APP
------------
After starting, open in Chrome AND Firefox:
  http://localhost:3000

Both browsers will see each other in real-time!


YOUR IP (for other devices on same WiFi)
-----------------------------------------
Windows: Open Command Prompt, type: ipconfig
         Look for "IPv4 Address" e.g. 192.168.1.50
         Use: http://192.168.1.50:3000

Mac:     Open Terminal, type: ifconfig | grep "inet "
         Use: http://YOUR.IP.HERE:3000


DEMO ACCOUNTS
-------------
demo@daywork.com    / password123
worker@daywork.com  / password123
marcus@daywork.com  / password123


FILES
-----
server.js        - The server (don't edit)
public/index.html - The app (don't edit)
data.json        - Your data (auto-saved, don't delete)
START.bat        - Windows launcher
START.sh         - Mac/Linux launcher

── NOTIFICATIONS SETUP ──────────────────────────────────────

Edit config.json to enable email and/or text notifications.

EMAIL (Gmail):
  1. Go to myaccount.google.com → Security → App Passwords
  2. Create an App Password for "Mail"
  3. Put your Gmail in gmail_user
  4. Put the App Password (16 chars) in gmail_pass

TEXT (Twilio):
  1. Sign up free at twilio.com
  2. Get your Account SID and Auth Token from the dashboard
  3. Get a free Twilio phone number
  4. Fill in twilio_sid, twilio_token, twilio_from

Then run: npm install
And start: node server.js

Notifications fire when:
  - A worker APPLIES to your job
  - A worker is HIRED (you click Hire)
