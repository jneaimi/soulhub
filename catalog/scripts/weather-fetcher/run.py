#!/usr/bin/env python3
"""weather-fetcher — Fetch current weather by country + city via Open-Meteo.

Config via BLOCK_CONFIG_* env vars:
    BLOCK_CONFIG_COUNTRY  — Country name (e.g. "United Arab Emirates")
    BLOCK_CONFIG_CITY     — City name (e.g. "Dubai")
    BLOCK_CONFIG_UNITS    — celsius or fahrenheit (default: celsius)

No API key required — uses Open-Meteo (free, open-source).
"""

import json
import os
import sys
import time
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.parse import quote

# ── Config from env ─────────────────────────────

COUNTRY = os.environ.get("BLOCK_CONFIG_COUNTRY", "").strip()
CITY = os.environ.get("BLOCK_CONFIG_CITY", "").strip()
UNITS = os.environ.get("BLOCK_CONFIG_UNITS", "celsius").strip().lower()

PIPELINE_OUTPUT = os.environ.get("PIPELINE_OUTPUT", "")

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"

# WMO Weather interpretation codes
WMO_CODES = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snowfall",
    73: "Moderate snowfall",
    75: "Heavy snowfall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
}


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr)


def api_get(url: str) -> dict:
    """Simple GET request, returns parsed JSON."""
    req = Request(url, headers={"User-Agent": "SoulHub-WeatherFetcher/1.0"})
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def geocode_city(city: str, country: str) -> dict | None:
    """Find city coordinates, filtered by country."""
    url = f"{GEOCODE_URL}?name={quote(city)}&count=10&language=en&format=json"
    log(f"Geocoding: {city}, {country}")

    data = api_get(url)
    results = data.get("results", [])

    if not results:
        return None

    # Match by country name (case-insensitive)
    country_lower = country.lower()
    for r in results:
        if r.get("country", "").lower() == country_lower:
            return r

    # Fallback: try country_code match (e.g. "AE", "SA")
    for r in results:
        if r.get("country_code", "").lower() == country_lower:
            return r

    # No country match — return first result with a warning
    log(f"  [WARN] No exact country match for '{country}', using best match: {results[0].get('country')}")
    return results[0]


def fetch_weather(lat: float, lon: float, fahrenheit: bool) -> dict:
    """Fetch current weather from Open-Meteo."""
    temp_unit = "fahrenheit" if fahrenheit else "celsius"
    wind_unit = "mph" if fahrenheit else "kmh"

    url = (
        f"{WEATHER_URL}?latitude={lat}&longitude={lon}"
        f"&current=temperature_2m,relative_humidity_2m,apparent_temperature,"
        f"weather_code,wind_speed_10m,wind_direction_10m,surface_pressure"
        f"&temperature_unit={temp_unit}&wind_speed_unit={wind_unit}"
        f"&timezone=auto"
    )

    log(f"Fetching weather for ({lat:.4f}, {lon:.4f})")
    return api_get(url)


def main():
    start = time.time()

    if not COUNTRY or not CITY:
        log("[ERROR] Both BLOCK_CONFIG_COUNTRY and BLOCK_CONFIG_CITY are required")
        print(json.dumps({"error": "Country and city are required"}))
        sys.exit(1)

    log(f"Weather Fetcher — {CITY}, {COUNTRY} ({UNITS})")

    # Step 1: Geocode
    location = geocode_city(CITY, COUNTRY)
    if not location:
        log(f"[ERROR] City '{CITY}' not found")
        print(json.dumps({"error": f"City '{CITY}' not found"}))
        sys.exit(1)

    lat = location["latitude"]
    lon = location["longitude"]
    resolved_country = location.get("country", COUNTRY)
    resolved_city = location.get("name", CITY)
    log(f"  Found: {resolved_city}, {resolved_country} ({lat:.4f}, {lon:.4f})")

    # Step 2: Fetch weather
    fahrenheit = UNITS == "fahrenheit"
    weather_data = fetch_weather(lat, lon, fahrenheit)
    current = weather_data.get("current", {})

    temp_unit = "F" if fahrenheit else "C"
    wind_unit = "mph" if fahrenheit else "km/h"
    weather_code = current.get("weather_code", -1)

    result = {
        "city": resolved_city,
        "country": resolved_country,
        "latitude": lat,
        "longitude": lon,
        "timezone": weather_data.get("timezone", ""),
        "temperature": current.get("temperature_2m"),
        "feels_like": current.get("apparent_temperature"),
        "temperature_unit": temp_unit,
        "humidity": current.get("relative_humidity_2m"),
        "wind_speed": current.get("wind_speed_10m"),
        "wind_direction": current.get("wind_direction_10m"),
        "wind_unit": wind_unit,
        "pressure_hpa": current.get("surface_pressure"),
        "condition": WMO_CODES.get(weather_code, f"Unknown ({weather_code})"),
        "weather_code": weather_code,
        "observation_time": current.get("time", ""),
    }

    elapsed = int(time.time() - start)

    log("=" * 40)
    log(f"  {resolved_city}, {resolved_country}")
    log(f"  {result['condition']}")
    log(f"  Temperature: {result['temperature']}{temp_unit} (feels like {result['feels_like']}{temp_unit})")
    log(f"  Humidity: {result['humidity']}%")
    log(f"  Wind: {result['wind_speed']} {wind_unit}")
    log(f"  Completed in {elapsed}s")
    log("=" * 40)

    # Write output
    output = json.dumps(result, indent=2)

    if PIPELINE_OUTPUT:
        os.makedirs(os.path.dirname(PIPELINE_OUTPUT), exist_ok=True)
        with open(PIPELINE_OUTPUT, "w") as f:
            f.write(output)
        log(f"Output written to {PIPELINE_OUTPUT}")

    print(output)


if __name__ == "__main__":
    main()
