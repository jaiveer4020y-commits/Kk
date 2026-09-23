"""
Unified Video Extractor API - Castle (Source 1) + Modiplay (Source 2)
Compatible with Vercel serverless deployment
"""

import base64
import json
import requests
import re
from urllib.parse import quote_plus, urlencode, unquote
from Crypto.Cipher import AES


# ============================================================
# CONFIGURATION
# ============================================================

CASTLE_API = "https://api.hlowb.com"
MODIPLAY_API = "https://rozgarlelo.modiplay.xyz"
WORKINGG_PROXY = "https://workingg.vercel.app/api/proxy"

CASTLE_CHANNEL = "IndiaA"
CASTLE_CLIENT_TYPE = "1"
CASTLE_LANG = "en-US"
CASTLE_PACKAGE_NAME = "com.external.castle"
CASTLE_KEY = "PUT_YOUR_CASTLE_KEY_HERE"

MODIPLAY_USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 10; K) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Mobile Safari/537.36"
)

CASTLE_HEADERS = {
    "User-Agent": "okhttp/4.9.3",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "Keep-Alive",
    "Referer": CASTLE_API + "/",
}

MODIPLAY_HEADERS = {
    "User-Agent": MODIPLAY_USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


# ============================================================
# CASTLE - AES DECRYPTION
# ============================================================

def decrypt_castle(cipher_text, security_key):
    """AES-128-CBC decryption for Castle API responses"""
    pepper = b"T!BgJB"
    key_words = base64.b64decode(security_key)
    combined = key_words + pepper
    key_material = combined[:16]
    cipher_bytes = base64.b64decode(cipher_text)
    cipher = AES.new(key_material, AES.MODE_CBC, iv=key_material)
    decrypted = cipher.decrypt(cipher_bytes)
    
    # PKCS5/PKCS7 padding removal
    padding = decrypted[-1]
    if 1 <= padding <= 16:
        decrypted = decrypted[:-padding]
    
    return decrypted.decode("utf-8")


# ============================================================
# CASTLE - SECURITY KEY
# ============================================================

def get_castle_security_key():
    """Fetch security key from Castle API"""
    url = (
        f"{CASTLE_API}/v0.1/system/getSecurityKey/1"
        f"?channel={CASTLE_CHANNEL}"
        f"&clientType={CASTLE_CLIENT_TYPE}"
        f"&lang={CASTLE_LANG}"
    )
    
    r = requests.get(url, headers=CASTLE_HEADERS, timeout=20)
    r.raise_for_status()
    
    data = r.json()
    security_key = data.get("data")
    
    if not security_key:
        raise Exception("Security key not found")
    
    return security_key


# ============================================================
# CASTLE - API REQUEST
# ============================================================

def castle_request(url, security_key, method="GET", body=None):
    """Make encrypted request to Castle API"""
    
    if method == "POST":
        r = requests.post(
            url,
            headers={**CASTLE_HEADERS, "Content-Type": "application/json"},
            json=body,
            timeout=30
        )
    else:
        r = requests.get(url, headers=CASTLE_HEADERS, timeout=30)
    
    r.raise_for_status()
    
    response = r.text.strip()
    cipher_text = response
    
    try:
        temp = json.loads(response)
        if isinstance(temp, dict) and isinstance(temp.get("data"), str):
            cipher_text = temp["data"]
    except:
        pass
    
    decrypted = decrypt_castle(cipher_text, security_key)
    result = json.loads(decrypted)
    
    if isinstance(result, dict) and isinstance(result.get("data"), dict):
        return result["data"]
    
    return result


# ============================================================
# CASTLE - SEARCH
# ============================================================

def castle_search(title, security_key):
    """Search for movie/series on Castle"""
    encoded_title = quote_plus(title)
    
    url = (
        f"{CASTLE_API}/film-api/v1.1.0/movie/searchByKeyword"
        f"?channel={CASTLE_CHANNEL}"
        f"&clientType={CASTLE_CLIENT_TYPE}"
        f"&keyword={encoded_title}"
        f"&lang={CASTLE_LANG}"
        f"&mode=1"
        f"&packageName={CASTLE_PACKAGE_NAME}"
        f"&page=1"
        f"&size=30"
    )
    
    data = castle_request(url, security_key)
    rows = data.get("rows", [])
    
    if not rows:
        raise Exception("No search results")
    
    movie_id = ""
    for row in rows:
        row_title = row.get("title") or row.get("name") or ""
        if title.lower() in row_title.lower() or row_title.lower() in title.lower():
            movie_id = str(row.get("id") or row.get("redirectId") or row.get("redirectIdStr") or "")
            if movie_id:
                break
    
    if not movie_id and rows:
        first = rows[0]
        movie_id = str(first.get("id") or first.get("redirectId") or first.get("redirectIdStr") or "")
    
    if not movie_id:
        raise Exception("Movie ID not found")
    
    return movie_id


# ============================================================
# CASTLE - GET DETAILS
# ============================================================

def castle_get_details(movie_id, security_key):
    """Get movie/series details"""
    url = (
        f"{CASTLE_API}/film-api/v1.9.9/movie"
        f"?channel={CASTLE_CHANNEL}"
        f"&clientType={CASTLE_CLIENT_TYPE}"
        f"&lang={CASTLE_LANG}"
        f"&movieId={movie_id}"
        f"&packageName={CASTLE_PACKAGE_NAME}"
    )
    
    return castle_request(url, security_key)


# ============================================================
# CASTLE - GET SEASON EPISODES
# ============================================================

def castle_get_season_details(season_movie_id, security_key):
    """Get episodes for a specific season"""
    url = (
        f"{CASTLE_API}/film-api/v1.9.9/movie"
        f"?channel={CASTLE_CHANNEL}"
        f"&clientType={CASTLE_CLIENT_TYPE}"
        f"&lang={CASTLE_LANG}"
        f"&movieId={season_movie_id}"
        f"&packageName={CASTLE_PACKAGE_NAME}"
    )
    
    return castle_request(url, security_key)


# ============================================================
# CASTLE - GET VIDEO
# ============================================================

def castle_get_video(movie_id, episode_id, security_key):
    """Get video URL for episode/movie"""
    url = (
        f"{CASTLE_API}/film-api/v2.0.1/movie/getVideo2"
        f"?clientType={CASTLE_CLIENT_TYPE}"
        f"&packageName={CASTLE_PACKAGE_NAME}"
        f"&channel={CASTLE_CHANNEL}"
        f"&lang={CASTLE_LANG}"
    )
    
    body = {
        "mode": "1",
        "appMarket": "GuanWang",
        "clientType": CASTLE_CLIENT_TYPE,
        "woolUser": "false",
        "apkSignKey": CASTLE_KEY,
        "androidVersion": "13",
        "movieId": movie_id,
        "episodeId": episode_id,
        "isNewUser": "true",
        "resolution": "2",
        "packageName": CASTLE_PACKAGE_NAME,
    }
    
    return castle_request(url, security_key, method="POST", body=body)


# ============================================================
# CASTLE - EXTRACT
# ============================================================

def extract_castle(title, season=None, episode=None):
    """Extract video from Castle API"""
    try:
        security_key = get_castle_security_key()
        movie_id = castle_search(title, security_key)
        details = castle_get_details(movie_id, security_key)
        
        effective_movie_id = movie_id
        
        # Handle TV series
        if season is not None and episode is not None:
            seasons = details.get("seasons", [])
            if seasons:
                season_data = None
                for s in seasons:
                    if s.get("number") == season:
                        season_data = s
                        break
                
                if season_data and season_data.get("movieId") != movie_id:
                    season_movie_id = season_data.get("movieId")
                    details = castle_get_season_details(season_movie_id, security_key)
                    effective_movie_id = season_movie_id
        
        # Get episode
        episodes = details.get("episodes", [])
        if not episodes:
            raise Exception("No episodes found")
        
        episode_data = None
        if season is not None and episode is not None:
            for ep in episodes:
                if ep.get("number") == episode:
                    episode_data = ep
                    break
        else:
            episode_data = episodes[0]
        
        if not episode_data:
            raise Exception("Episode not found")
        
        episode_id = episode_data.get("id")
        
        # Get video
        video_data = castle_get_video(effective_movie_id, episode_id, security_key)
        
        return {
            "success": True,
            "source": "castle",
            "title": title,
            "season": season,
            "episode": episode,
            "videoUrl": video_data.get("videoUrl"),
            "subtitles": video_data.get("subtitles", []),
        }
    
    except Exception as e:
        return {
            "success": False,
            "source": "castle",
            "error": str(e),
        }


# ============================================================
# MODIPLAY - FETCH PAGE
# ============================================================

def modiplay_fetch_page(url, referer=None):
    """Fetch HTML from URL"""
    headers = {**MODIPLAY_HEADERS}
    if referer:
        headers["Referer"] = referer
    
    r = requests.get(url, headers=headers, allow_redirects=True, timeout=20)
    r.raise_for_status()
    
    return r.text, r.url


# ============================================================
# MODIPLAY - EXTRACT PLAYER IFRAME
# ============================================================

def modiplay_extract_player_iframe(html, base_url):
    """Extract iframe#playerFrame or id=playerFrame"""
    
    # Look for iframe with id="playerFrame"
    iframe_regex = r'<iframe\b[^>]*\bid\s*=\s*["\']playerFrame["\'][^>]*>'
    match = re.search(iframe_regex, html, re.IGNORECASE)
    
    if not match:
        # Try alternative id pattern
        iframe_regex = r'<iframe\b[^>]*>'
        matches = re.finditer(iframe_regex, html, re.IGNORECASE)
        for m in matches:
            tag = m.group(0)
            if 'playerFrame' in tag or 'playerContainer' in tag:
                match = m
                break
    
    if not match:
        return None
    
    tag = match.group(0)
    src_match = re.search(r'\bsrc\s*=\s*["\']([^"\']+)["\']', tag, re.IGNORECASE)
    
    if not src_match:
        return None
    
    src = src_match.group(1).strip()
    
    # Make absolute URL
    if src.startswith('/'):
        from urllib.parse import urlparse, urlunparse
        parsed = urlparse(base_url)
        src = f"{parsed.scheme}://{parsed.netloc}{src}"
    elif not src.startswith('http'):
        src = base_url.rstrip('/') + '/' + src
    
    return src


# ============================================================
# MODIPLAY - EXTRACT DIRECT SRC
# ============================================================

def modiplay_extract_direct_src(html):
    """Extract directSrc variable from JavaScript"""
    
    # Look for var directSrc="..."
    match = re.search(r'var\s+directSrc\s*=\s*["\']([^"\']+)["\']', html)
    
    if match:
        src = match.group(1).strip()
        # Decode if URL encoded
        src = unquote(src)
        return src
    
    # Fallback: look for src= pattern
    match = re.search(r'var\s+src\s*=\s*["\']([^"\']+)["\']', html)
    if match:
        src = match.group(1).strip()
        src = unquote(src)
        return src
    
    return None


# ============================================================
# MODIPLAY - EXTRACT
# ============================================================

def extract_modiplay(media_id, media_type="tv", season=None, episode=None):
    """Extract video from Modiplay"""
    try:
        # Build embed URL
        if media_type == "tv":
            embed_url = (
                f"{MODIPLAY_API}/embed/tmdb/tv"
                f"?id={media_id}&s={season}&e={episode}"
            )
        else:
            embed_url = (
                f"{MODIPLAY_API}/embed/tmdb/movie"
                f"?id={media_id}"
            )
        
        # Fetch embed page
        embed_html, embed_final_url = modiplay_fetch_page(embed_url)
        
        # Extract player iframe
        player_iframe_url = modiplay_extract_player_iframe(embed_html, embed_final_url)
        
        if not player_iframe_url:
            raise Exception("Could not extract player iframe")
        
        # Fetch player iframe page
        player_html, player_final_url = modiplay_fetch_page(player_iframe_url, referer=embed_final_url)
        
        # Extract direct src (m3u8 URL)
        direct_src = modiplay_extract_direct_src(player_html)
        
        if not direct_src:
            raise Exception("Could not extract directSrc")
        
        # Make absolute URL if needed
        if direct_src.startswith('/'):
            from urllib.parse import urlparse
            parsed = urlparse(player_final_url)
            direct_src = f"{parsed.scheme}://{parsed.netloc}{direct_src}"
        
        return {
            "success": True,
            "source": "modiplay",
            "media_id": media_id,
            "media_type": media_type,
            "season": season,
            "episode": episode,
            "videoUrl": direct_src,
            "embedUrl": embed_url,
            "playerUrl": player_iframe_url,
        }
    
    except Exception as e:
        return {
            "success": False,
            "source": "modiplay",
            "error": str(e),
        }


# ============================================================
# UNIFIED API HANDLER
# ============================================================

def handle_request(params):
    """Handle API request with both sources"""
    
    source = params.get("source", "both")
    media_type = params.get("type", "tv")
    
    results = {
        "timestamp": str(__import__('datetime').datetime.now().isoformat()),
        "params": params,
        "results": [],
    }
    
    # Castle: requires title
    if source in ("castle", "both"):
        title = params.get("title")
        if title:
            season = params.get("season")
            episode = params.get("episode")
            if season:
                season = int(season)
            if episode:
                episode = int(episode)
            
            result = extract_castle(title, season, episode)
            results["results"].append(result)
    
    # Modiplay: requires media_id
    if source in ("modiplay", "both"):
        media_id = params.get("id") or params.get("media_id")
        if media_id:
            season = params.get("season")
            episode = params.get("episode")
            if season:
                season = int(season)
            if episode:
                episode = int(episode)
            
            result = extract_modiplay(media_id, media_type, season, episode)
            results["results"].append(result)
    
    return results


# ============================================================
# VERCEL HANDLER
# ============================================================

def handler(request):
    """Vercel serverless function handler"""
    
    # CORS headers
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
    }
    
    # Handle OPTIONS
    if request.method == "OPTIONS":
        return ("", 204, headers)
    
    # Only allow GET and POST
    if request.method not in ("GET", "POST"):
        return (
            json.dumps({"ok": False, "error": "Method not allowed"}),
            405,
            headers,
        )
    
    try:
        # Parse parameters
        if request.method == "GET":
            params = request.args.to_dict() if hasattr(request.args, 'to_dict') else dict(request.args)
        else:
            params = request.get_json() or {}
        
        # Handle request
        result = handle_request(params)
        
        return (
            json.dumps(result, indent=2),
            200,
            headers,
        )
    
    except Exception as e:
        return (
            json.dumps({"ok": False, "error": str(e)}),
            500,
            headers,
        )


# ============================================================
# STANDALONE USAGE (for testing)
# ============================================================

if __name__ == "__main__":
    import sys
    
    print("Unified Video Extractor API")
    print("=" * 60)
    
    # Example: Castle - Game of Thrones S1E1
    print("\n[TEST 1] Castle - Game of Thrones S1E1")
    result1 = extract_castle("Game of Thrones", season=1, episode=1)
    print(json.dumps(result1, indent=2))
    
    # Example: Modiplay - TV Show
    print("\n[TEST 2] Modiplay - Game of Thrones S1E1")
    result2 = extract_modiplay("1399", media_type="tv", season=1, episode=1)
    print(json.dumps(result2, indent=2))
    
    # Example: Modiplay - Movie
    print("\n[TEST 3] Modiplay - Movie (ID: 672)")
    result3 = extract_modiplay("672", media_type="movie")
    print(json.dumps(result3, indent=2))
