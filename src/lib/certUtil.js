function collectPeerCertificates(connection) {
    const tlsSocket = connection?.socket?.socket;
    if (!tlsSocket || typeof tlsSocket.getPeerCertificate !== 'function') {
        return [];
    }

    let certificate;
    try {
        certificate = tlsSocket.getPeerCertificate(true);
    } catch {
        return [];
    }

    const certificates = [];
    const seen = new Set();

    const pushChain = item => {
        let current = item;
        while (current && !seen.has(current)) {
            seen.add(current);
            if (current.raw) {
                certificates.push(Buffer.from(current.raw));
            }

            if (!current.issuerCertificate || current.issuerCertificate === current) {
                break;
            }

            current = current.issuerCertificate;
        }
    };

    if (Array.isArray(certificate)) {
        for (const item of certificate) {
            pushChain(item);
        }
    } else {
        pushChain(certificate);
    }

    return certificates.reverse();
}

export { collectPeerCertificates };
