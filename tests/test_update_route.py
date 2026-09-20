import unittest
from email.message import Message

from server import Handler


def request_is_authorized(**headers):
    handler = object.__new__(Handler)
    message = Message()
    for name, value in headers.items():
        message[name.replace("_", "-")] = value
    handler.headers = message
    return handler._authorized_update_request()


class UpdateRouteAuthorizationTests(unittest.TestCase):
    def test_same_origin_json_request_is_allowed(self):
        self.assertTrue(
            request_is_authorized(
                Content_Type="application/json",
                X_CHV_Update="1",
                Host="127.0.0.1:5174",
                Origin="http://127.0.0.1:5174",
                Sec_Fetch_Site="same-origin",
            )
        )

    def test_cross_origin_request_is_rejected(self):
        self.assertFalse(
            request_is_authorized(
                Content_Type="application/json",
                X_CHV_Update="1",
                Host="127.0.0.1:5174",
                Origin="https://example.com",
                Sec_Fetch_Site="cross-site",
            )
        )

    def test_simple_form_post_is_rejected(self):
        self.assertFalse(
            request_is_authorized(
                Content_Type="application/x-www-form-urlencoded",
                Host="127.0.0.1:5174",
                Origin="https://example.com",
            )
        )

    def test_missing_update_header_is_rejected(self):
        self.assertFalse(
            request_is_authorized(
                Content_Type="application/json",
                Host="127.0.0.1:5174",
                Origin="http://127.0.0.1:5174",
            )
        )


if __name__ == "__main__":
    unittest.main()
