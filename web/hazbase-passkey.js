function ensureBrowserSupport() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('WebAuthn is only available in a browser environment');
  }
}

function toBase64url(input) {
  if (!input) throw new Error('Expected binary data from WebAuthn response');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function algorithmFromCode(code) {
  if (code === -257) return 'RS256';
  return 'ES256';
}

export async function createPasskeyRegistrationCredential(challenge) {
  ensureBrowserSupport();
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: fromBase64url(challenge.challenge),
      rp: { id: challenge.rpId, name: challenge.rpName },
      user: {
        id: fromBase64url(challenge.userHandle),
        name: challenge.userName,
        displayName: challenge.userDisplayName,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: challenge.timeoutMs,
      authenticatorSelection: {
        userVerification: 'required',
        residentKey: 'preferred',
      },
      attestation: 'none',
      excludeCredentials: (challenge.excludeCredentialIds || []).map((credentialId) => ({
        id: fromBase64url(credentialId),
        type: 'public-key',
      })),
    },
  });

  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error('Passkey registration failed');
  }
  const response = credential.response;
  const publicKey = response.getPublicKey?.();
  const algorithm = response.getPublicKeyAlgorithm?.();
  const authenticatorData = response.getAuthenticatorData?.();
  if (!publicKey || algorithm == null || !authenticatorData) {
    throw new Error('This browser does not expose the WebAuthn attestation details required by hazBase');
  }

  return {
    username: challenge.userName,
    credential: {
      id: credential.id,
      publicKey: toBase64url(publicKey),
      algorithm: algorithmFromCode(algorithm),
    },
    authenticatorData: toBase64url(authenticatorData),
    clientData: toBase64url(response.clientDataJSON),
    attestationData: toBase64url(response.attestationObject),
  };
}

export async function createPasskeyAssertionCredential(challenge) {
  ensureBrowserSupport();
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64url(challenge.challenge),
      rpId: challenge.rpId,
      userVerification: 'required',
      timeout: challenge.timeoutMs,
      allowCredentials: (challenge.credentialIds || []).map((credentialId) => ({
        id: fromBase64url(credentialId),
        type: 'public-key',
      })),
    },
  });

  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error('Passkey assertion failed');
  }
  const response = credential.response;
  return {
    credentialId: credential.id,
    authenticatorData: toBase64url(response.authenticatorData),
    clientData: toBase64url(response.clientDataJSON),
    signature: toBase64url(response.signature),
    ...(response.userHandle ? { userHandle: toBase64url(response.userHandle) } : {}),
  };
}
