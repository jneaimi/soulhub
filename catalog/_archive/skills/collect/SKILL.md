---
name: collect
description: Collect data from social media platforms and news sources for research. Use when gathering signals or market data.
user-invocable: true
---

# Collect (/collect)

Gather posts, comments, and articles from multiple platforms.

## Platforms
Twitter, Reddit, TikTok, Instagram, YouTube, LinkedIn, News, Forums

## Usage
Specify topic + platforms. Results are deduplicated and filtered by minimum engagement.

## Output
JSON array of posts with: platform, author, content, engagement metrics, timestamp.
