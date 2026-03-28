# Deploying DAYWORK to Railway

## Step 1 — Sign up
Go to railway.app → click "Start a New Project" → sign up with GitHub (free)

## Step 2 — Create project
Click "Deploy from GitHub repo"
OR
Click "Empty project" → then drag and drop this folder

## Step 3 — Upload files
If using GitHub:
  1. Create a free GitHub account at github.com
  2. Create a new repo called "daywork"
  3. Upload all files from this folder to the repo
  4. In Railway, select that repo

If not using GitHub:
  1. Install Railway CLI: npm install -g @railway/cli
  2. Open terminal in this folder
  3. Run: railway login
  4. Run: railway up

## Step 4 — Set environment variables (optional)
In Railway dashboard → your project → Variables:
  GMAIL_USER = lcount321@gmail.com
  GMAIL_PASS = your-app-password

## Step 5 — Get your URL
Railway gives you a free URL like:
  daywork-production.up.railway.app

## Step 6 — Custom domain (optional)
In Railway → Settings → Custom Domains
Add your domain (bought from namecheap.com)
Follow the DNS instructions

## That's it!
Your app is live 24/7 at the Railway URL.
