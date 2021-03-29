# Set up build
FROM node:lts@sha256:fe842f5b828c121514d62cbe0ace0927aec4f3130297180c3343e54e7ae97362 AS build

WORKDIR /usr/src

COPY . ./

RUN npm ci --no-optional && \
    npm run compile && \
    rm -rf node_modules .git

FROM ubuntu:focal@sha256:64255397e256fd33d6c6ddbc371027093315f9822089a32b8eeb045d83bb91c4

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
    && sdk install java 15.0.1.hs-adpt  \
    && sdk install java 14.0.2.hs-adpt  \
    && sdk install java 13.0.2.hs-adpt  \
    && sdk install java 12.0.2.hs-adpt  \
    && sdk install java 11.0.9.hs-adpt  \
    && sdk install java 8.0.275.hs-adpt  \
    && sdk default java 11.0.9.hs-adpt"

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

