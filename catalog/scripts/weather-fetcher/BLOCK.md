---
name: weather-fetcher
type: script
runtime: python
description: Fetch current weather details by selecting a country then city
author: jasem
version: 1.0.0

inputs: []

outputs:
  - name: weather
    type: json
    description: Current weather data for the selected city

config:
  - name: country
    type: text
    label: Country
    description: Country name (e.g. United Arab Emirates, Saudi Arabia)
    required: true
  - name: city
    type: text
    label: City
    description: City name within the selected country (e.g. Dubai, Riyadh)
    required: true
  - name: units
    type: select
    label: Temperature units
    description: Celsius or Fahrenheit
    options: [celsius, fahrenheit]
    default: celsius

env: []

data: {}
---

# Weather Fetcher

Fetch current weather details for any city using Open-Meteo (free, no API key).

## How it works
1. Takes country + city from config
2. Geocodes the city via Open-Meteo Geocoding API
3. Filters results to match the selected country
4. Fetches current weather (temperature, humidity, wind, conditions)
5. Outputs structured JSON

## Files
- `run.py` — main script
- `BLOCK.md` — this manifest
