// clientCertRequester.js
const WebSocket = require("ws");
const crypto = require("crypto");

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return { publicKeyPem, privateKey };
}

function signPublicKey(publicKeyPEM, privateKey) {
  const signer = crypto.createSign('sha256');
  signer.update(publicKeyPEM);
  signer.end();
  return signer.sign(privateKey, 'base64');
}

function verifyCert(cert, caPublicKeyPem) {
  const { certSignature, ...unsignedCert } = cert;
  const verifier = crypto.createVerify('sha256');
  verifier.update(JSON.stringify(unsignedCert));
  verifier.end();
  const caKey = crypto.createPublicKey(caPublicKeyPem);
  return verifier.verify(caKey, certSignature, 'base64');
}

async function requestCertificateFromHub(hubUrl = "ws://relay-h2hg.onrender.com/hub", clientId = "node-client-1", role = "render-peer") {
  const roomId = Math.random().toString(36).substring(2, 10);
  const ws = new WebSocket(`${hubUrl}/${roomId}`);

  const { publicKeyPem, privateKey } = generateKeyPair();

  return new Promise((resolve, reject) => {
    ws.on("open", () => {
      console.log(`[HubClient] Connected to ${roomId}`);
      ws.send(JSON.stringify({ type: "hello", clientId }));
    });

    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString());

      if (parsed.type === "talk" && parsed.peerlength === 2) {
        ws.send(JSON.stringify({
          type: "csr",
          publicKey: publicKeyPem,
          signature: signPublicKey(publicKeyPem, privateKey),
          clientId,
          role,
          timestamp: Date.now()
        }));
      } else if (parsed.type === "key-signed") {
        const { certificate } = parsed;
        const caPublicKey = certificate.caPublicKey;
        const challengeroom = parsed.roomId;
        delete parsed.roomId;
        delete certificate.caPublicKey;
        const clientId = certificate.clientId; // {test 2} Just for debugging
        delete certificate.clientId;

        if (!verifyCert(certificate, caPublicKey)) {
          reject(new Error("⚠️ Certificate is not trusted."));
        } else {
          console.log(`[HubClient] Certificate verified for ${clientId}`);
          resolve({ certificate, privateKey, caPublicKey, roomId: challengeroom});
          ws.close();
        }
      }
    });

    ws.on("error", reject);
    ws.on("close", () => console.log("[HubClient] Disconnected"));
  });
}

async function runAuthenticatedClient(hubUrl = "ws://relay-h2hg.onrender.com/hub", certificate, privateKey, caPublicKey, roomId) {
  return new Promise((resolve, reject) => {
    try {

      console.log("✅ Certificates issued and verified");

      ws = new WebSocket(`${hubUrl}/${roomId}`);
      const clientId = Math.random().toString(36).substring(2, 10);

      ws.on("open", () => {
          console.log("[ws] Connected");
          ws.send(JSON.stringify({ type: "hello", clientId })); // probably make clientId random
      });

      ws.on("message", (data) => {
          const msg = JSON.parse(data);
          if (msg.type === "hello" && msg.peerlength === 2) {
              nonceFrom1 = crypto.randomBytes(32).toString('hex');
              console.log("[ws] Sending nonce:", nonceFrom1);
              ws.send(JSON.stringify({
                  type: "nonce-challenge",
                  nonce: nonceFrom1,
                  cert: certificate
              }));
          }

          if (msg.type === "nonce-response" && msg.peerlength === 2) {
              const { signedNonce, cert } = msg;
              const isTrusted = verifyCert(cert, caPublicKey);
              if (!isTrusted) return console.log("❌ Untrusted cert");

              const verifier = crypto.createVerify('sha256');
              verifier.update(nonceFrom1);
              verifier.end();

              const valid = verifier.verify(cert.publicKey, signedNonce, 'base64');
              console.log(valid ? "✅ ws authenticated" : "❌ Invalid signature from ws");
              ws.close();
              if (valid) {
                resolve({ clientPubKey: cert.publicKey });
              } else {
                reject(new Error("Invalid signature"));
              }
          }
          if (msg.type === "nonce-challenge" && msg.peerlength === 2) {
              const signer = crypto.createSign('sha256');
              signer.update(msg.nonce);
              signer.end();
              const signedNonce = signer.sign(privateKey, 'base64');

              ws.send(JSON.stringify({
                  type: "nonce-response",
                  signedNonce,
                  cert: certificate
              }), () => {
                ws.close();
                resolve({});
              });
          }
      });
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
  })
};

async function runAuthenticatedClient2Ways(hubUrl = "ws://relay-h2hg.onrender.com/hub", certificate, privateKey, caPublicKey, roomId) {
  return new Promise((resolve, reject) => {
    try {

      let clientPubKey;

      console.log("✅ Certificates issued and verified");

      ws = new WebSocket(`${hubUrl}/${roomId}`);
      const clientId = Math.random().toString(36).substring(2, 10);

      ws.on("open", () => {
          console.log("[ws] Connected");
          ws.send(JSON.stringify({ type: "hello", clientId })); // probably make clientId random
      });

      ws.on("message", (data) => {
          const msg = JSON.parse(data);
          if (msg.type === "hello" && msg.peerlength === 2) {
              nonceFrom1 = crypto.randomBytes(32).toString('hex');
              console.log("[ws] Sending nonce:", nonceFrom1);
              ws.send(JSON.stringify({
                  type: "nonce-challenge",
                  nonce: nonceFrom1,
                  cert: certificate
              }));
          }

          if (msg.type === "nonce-response" && msg.peerlength === 2) {
              const { signedNonce, cert } = msg;
              const isTrusted = verifyCert(cert, caPublicKey);
              if (!isTrusted) return console.log("❌ Untrusted cert");

              const verifier = crypto.createVerify('sha256');
              verifier.update(nonceFrom1);
              verifier.end();

              const valid = verifier.verify(cert.publicKey, signedNonce, 'base64');
              console.log(valid ? "✅ ws authenticated" : "❌ Invalid signature from ws");
              if (valid) {
                clientPubKey = cert.publicKey;
              } else {
                reject(new Error("Invalid signature"));
              }
          }
          if (msg.type === "nonce-challenge" && msg.peerlength < 3) {
              const signer = crypto.createSign('sha256');
              signer.update(msg.nonce);
              signer.end();
              const signedNonce = signer.sign(privateKey, 'base64');

              ws.send(JSON.stringify({
                type: "nonce-response",
                signedNonce,
                cert: certificate
              }), () => {
                // Instead of closing, it send the challenge back:
                nonceFrom1 = crypto.randomBytes(32).toString('hex');
                console.log("[ws] Sending nonce:", nonceFrom1);
                ws.send(JSON.stringify({
                  type: "nonce-challenge",
                  nonce: nonceFrom1,
                  cert: certificate
                }), () => {
                  // ✅ Only now close
                  if (clientPubKey) {
                    ws.close();
                    resolve({clientPubKey});
                  }
                });
              });
          }
      });
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
  })
};

module.exports = { runAuthenticatedClient, runAuthenticatedClient2Ways, requestCertificateFromHub };
