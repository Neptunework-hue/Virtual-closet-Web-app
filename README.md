# Virtual Closet (Web)

## What it is

**Virtual Closet** is a web app for discovering outfits, saving them to your personal closet, and **virtually trying them on** using AI. It connects to **Supabase**.

The **Explore** page takes inspiration from **Pinterest**: a masonry-style feed, search, and card layout—adapted to match this app’s look and flows (likes, `…` quick actions, try-on, etc.).

## Problem it solves

- **Shopping & styling**: See looks from the community feed, save favorites, and keep everything organized in one place.
- **Try before you mentally “buy”**: Upload a **full-body** or **face (avatar)** reference photo once in **Setup**, then generate **try-on images** so you can preview how outfits might look on you—without a separate credit system on web.

## Setup

1. **Clone / open** this project and install dependencies:

   ```bash
   npm install
   ```

2. **Environment** — copy `.env.example` to `.env` and set:

   - `VITE_SUPABASE_URL` — your Supabase project URL  
   - `VITE_SUPABASE_ANON_KEY` — your Supabase anon (public) key  

3. **Optional (try-on)** — configure your Gemini / API keys as required by `src/gemini.ts` if you use AI try-on (same expectations as your existing backend setup).

4. **Run locally**:

   ```bash
   npm run dev
   ```

5. **Production build**:

   ```bash
   npm run build
   ```

Your Supabase project needs the same tables, storage buckets, and policies as the mobile app (e.g. profiles, closet, outfits, explore feed, outfit likes). If something fails, check the browser console and Supabase logs for RLS or missing bucket errors.
