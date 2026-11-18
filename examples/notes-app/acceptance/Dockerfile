FROM node:22-alpine
WORKDIR /acceptance
COPY acceptance/e2e.mjs ./e2e.mjs
USER node
CMD ["node", "e2e.mjs"]
