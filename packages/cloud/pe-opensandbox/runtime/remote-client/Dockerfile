FROM sha256:62016189c3c5cec1c88d10af21b5dc0dfac0fc2247cd66709374dbdfc9d1135a
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      libcbor0.10=0.10.2-2 \
      libcom-err2=1.47.2-3+b12 \
      libedit2=3.1-20250104-1 \
      libfido2-1=1.15.0-1+b1 \
      libgssapi-krb5-2=1.21.3-5+deb13u1 \
      libk5crypto3=1.21.3-5+deb13u1 \
      libkeyutils1=1.6.3-6 \
      libkrb5-3=1.21.3-5+deb13u1 \
      libkrb5support0=1.21.3-5+deb13u1 \
      openssh-client=1:10.0p1-7+deb13u4 \
    && dpkg-query -W -f='${Package}\t${Version}\t${Installed-Size}\n' \
      libcbor0.10 libcom-err2 libedit2 libfido2-1 libgssapi-krb5-2 libk5crypto3 \
      libkeyutils1 libkrb5-3 libkrb5support0 openssh-client > /opt/dsh-remote-client-package-lock.txt \
    && /usr/bin/ssh -V \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb \
    && chmod 0444 /opt/dsh-remote-client-package-lock.txt
