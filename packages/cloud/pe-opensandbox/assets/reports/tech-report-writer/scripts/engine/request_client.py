"""
统一的 HTTP 请求客户端，具备自动重试能力。
"""

import time

import requests


def request_get(url: str, timeout: int = 30, headers: dict = None, max_retries: int = 3) -> requests.Response:
    """
    发送 GET 请求，失败时自动重试。

    Args:
        url: 请求地址。
        timeout: 超时时间（秒）。
        headers: 请求头。
        max_retries: 最大重试次数。

    Returns:
        requests.Response 对象。

    Raises:
        requests.exceptions.RequestException: 所有重试均失败时抛出。
    """
    last_exception = None
    for attempt in range(max_retries):
        try:
            response = requests.get(url, timeout=timeout, headers=headers or {})
            return response
        except requests.exceptions.RequestException as e:
            last_exception = e
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)  # 指数退避：1s, 2s, 4s

    raise last_exception  # type: ignore[misc]
