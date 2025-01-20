# Task Classifier Example

### Three versions

- [01-no-humans.ts](./01-no-humans.ts) - classify the emails with no human intervention
- [02-humans.ts](./02-human-review-sync.ts) - classify the emails, checking with a human before saving classifications, then print results
- [03-humans-async.ts](./03-humans-async.ts) - classify the emails, print them out, then start a webserver to listen for human overrides. When a human feedback is received, print the updated list.

### Running the examples

```
npm install
npm run no-humans
npm run human-review-sync
npm run human-review-async
```

For all three examples, you'll need to set `OPENAI_API_KEY` in your environment.

For the human-review examples, you'll need to set `HUMANLAYER_API_KEY` in your environment. You can get one at [app.humanlayer.dev](https://app.humanlayer.dev/).

For the `human-review-async` example, you will need to configure HumanLayer to send a [Response Webhook](https://humanlayer.dev/docs/core/response-webhooks) to your local server using ngrok or similar.

### 01-no-humans.ts

In this example, we just classify the emails and print the results of the LLM classification.

![no-humans](./img/no-humans.png)

### 02-human-review-sync.ts

In this example, each email is sent synchronously to a human for review, and then all results are printed at the end.

![human-review-sync](./img/human-review-sync.png)

### 03-human-review-async.ts

In this example, all LLM classifications are computed, and then they are all sent to a human for review. When a human review is completed, it will
be received by a webhook, and the results will be printed out.

![human-review-async](./img/human-review-async.png)

## Humanlayer Cookbooks and Examples

- [ts_email_classifier](./ts_email_classifier) - basic example of various classification/labeling workflows, using an llm to label emails and then providing sync or async mechanisms for human input on classifications

# 03-human-review-async.ts Email Classifier GUIDE

This project demonstrates email classification with asynchronous human review using HumanLayer's webhooks and MySQL storage.

## Key Differences from Sync Classifier
- Human Review Requests are asynchronous (sent concurrently)
- Uses HumanLayer's Response Webhooks  
- Stores data in MySQL via Docker

## Local Setup Guide

### 1. Install Dependencies
cd ts_email_classifier
npm install

### 2. Set up ngrok and HumanLayer Webhook
Configure webhook at https://app.humanlayer.dev/:
Use the ngrok HTTPS URL + /webhook
Save the webhook secret

### 3. Configure Environment
HUMANLAYER_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
HUMANLAYER_WEBHOOK_SECRET=your_webhook_secret
# MySQL Config
DB_HOST=127.0.0.1
DB_USER=root
DB_PASSWORD=p123
DB_NAME=email_classifier

### 4. Start MySQL Database
docker-compose up -d

### 5. Run the Classifier
npm run human-review-async

### 6. Test the Endpoint
curl -X POST http://localhost:3000/process

Watch terminal output for processing status
Check HumanLayer Dashboard (https://app.humanlayer.dev/) for review requests
View MySQL database for classification results (docker exec -it ts_email_classifier-mysql-1 mysql -u root -pp123 -e "USE email_classifier; SELECT * FROM email_classifications ORDER BY created_at DESC;")




