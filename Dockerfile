# Set up build
FROM node:lts@sha256:359104ed81c918c2ca3bfb01faa069e33949013fde25c6a471b0fa27d19d78ca AS build

WORKDIR /usr/src

COPY . ./

RUN npm ci --no-optional && \
    npm run compile && \
    rm -rf node_modules .git

FROM ubuntu:rolling@sha256:54bb6cbe5bfa4c5741fc8baa547dc95cf3fdbd5c55a5ed4784fed077e0bf9d87

# tools
RUN apt-get update && apt-get install -y \
        curl \
        wget \
        gnupg \
        git \
        build-essential \
        zip \
        unzip \
        && rm -rf /var/lib/apt/lists/*

# sdkman
ENV SDKMAN_DIR /opt/.sdkman
RUN curl -s "https://get.sdkman.io" | bash
RUN echo "sdkman_auto_answer=false" > $SDKMAN_DIR/etc/config

# java
RUN bash -c "source $SDKMAN_DIR/bin/sdkman-init.sh \
    && sdk install java 11.0.11.hs-adpt \
    && java --version"

# gradle
RUN bash -c "source $SDKMAN_DIR/bin/sdkman-init.sh \
    && sdk install gradle \
    && gradle --version"
ENV GRADLE_USER_HOME /atm/home/.gradle

# node
RUN curl -sL https://deb.nodesource.com/setup_14.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR "/skill"

COPY package.json package-lock.json ./

RUN bash -c "npm ci --no-optional \
    && npm cache clean --force"

COPY --from=build /usr/src/ .

WORKDIR "/atm/home"

ENV NODE_NO_WARNINGS 1

ENTRYPOINT ["node", "--no-deprecation", "--no-warnings", "--expose_gc", "--optimize_for_size", "--always_compact", "--max_old_space_size=512", "/skill/node_modules/.bin/atm-skill"]
CMD ["run"]

