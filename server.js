require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GRAPH_VERSION = "v24.0";

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "instagram-publisher-backend" });
});

app.get("/auth/meta/start", (req, res) => {
  const redirectUri = process.env.REDIRECT_URI;
  const appId = process.env.META_APP_ID;

  if (!redirectUri || !appId) {
    return res.status(500).json({
      error: "META_APP_ID and REDIRECT_URI must be configured"
    });
  }

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management"
  });

  res.redirect(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`);
});

app.get("/auth/meta/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing OAuth code.");

  try {
    const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    url.searchParams.set("client_id", process.env.META_APP_ID);
    url.searchParams.set("client_secret", process.env.META_APP_SECRET);
    url.searchParams.set("redirect_uri", process.env.REDIRECT_URI);
    url.searchParams.set("code", code);

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json({
      message: "Meta authorization successful.",
      note: "Store the access token securely; do not share it publicly.",
      token_received: Boolean(data.access_token),
      expires_in: data.expires_in || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/publish/image", async (req, res) => {
  const { access_token, ig_user_id, image_url, caption = "" } = req.body;

  if (!access_token || !ig_user_id || !image_url) {
    return res.status(400).json({
      error: "access_token, ig_user_id and image_url are required"
    });
  }

  try {
    const createUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${ig_user_id}/media`;
    const createParams = new URLSearchParams({
      image_url,
      caption,
      access_token
    });

    const createResponse = await fetch(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createParams
    });
    const creation = await createResponse.json();

    if (!createResponse.ok) return res.status(createResponse.status).json(creation);

    const publishUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${ig_user_id}/media_publish`;
    const publishParams = new URLSearchParams({
      creation_id: creation.id,
      access_token
    });

    const publishResponse = await fetch(publishUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: publishParams
    });
    const published = await publishResponse.json();

    if (!publishResponse.ok) return res.status(publishResponse.status).json(published);

    res.json({ success: true, published });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Instagram publisher backend running on port ${PORT}`);
});
