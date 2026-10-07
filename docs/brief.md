**

# Candidate brief: Scheduled notification dispatcher

AI-assisted coding round. Backend. Any language. MySQL 8 or PostgreSQL.

  

You build a service that sends scheduled notifications (SMS, WhatsApp, email) for marketing campaigns. A campaign has a list of recipients and a send time. Worker processes find the messages that are due and send them through a provider.

## Data

- A campaign has: id, tenant_id, channel, send_at, status, and a list of recipients.
    
- A message is one recipient in one campaign. It has: campaign_id, user_id, status, attempts.
    

## Rules

1. Exactly one send. The service sends each (campaign_id, user_id) message one time only. This rule applies when two or more worker processes poll the same database.
    
2. No early send. The service never sends a message before send_at.
    
3. Cancel. A cancelled campaign sends no more messages. Some messages can already be in progress when a cancel occurs. The status endpoint must show the true result for each of them. A second cancel call does nothing.
    
4. Provider failures. The provider can return an error or a timeout. After a timeout, you do not know if the provider sent the message. Retry with backoff, up to 5 attempts, and then mark the message FAILED. A retry must not make a second send.
    
5. Worker crash. A worker can stop at any time (kill -9), also after it claims a message. Another worker must finish that message. The message must not stay stuck, and it must not go out two times.
    
6. Rate limit. Each tenant has a limit of N sends per second. The limit applies to all workers together, not to each process.
    
7. Correct counts. GET /campaigns/:id returns the count of messages in each status. The counts are correct at all times, not eventually correct.
    

## API

- POST /campaigns with body { tenant_id, channel, send_at, recipients: [user_id, ...] }. This is seed data.
    
- POST /campaigns/:id/cancel
    
- GET /campaigns/:id returns { status, counts: { pending, in_progress, sent, failed, cancelled } }
    

## Mock provider

You build the mock provider. With AI, this takes about 10 minutes.

  

- POST /send with an Idempotency-Key header. The provider sends a message one time for each key, and it records each accepted send with a timestamp.
    
- The mock fails at random: 20% errors and 10% timeouts. On a timeout, the mock sends the message but does not reply.
    
- GET /stats returns the accepted sends for each key, with their timestamps.
    

## You must also ship

- A schema file that you write. Do not let a framework generate it.
    
- A test that runs one API process, two worker processes and the mock provider, all on the same database. The test must:
    

- seed 1,000 messages and prove that the provider accepted each message exactly one time,
    
- prove that no send occurred before send_at,
    
- kill one worker during the run and prove that all messages still finish,
    
- prove from the provider timestamps that no tenant went above N sends in any one-second window.
    

- A README that tells how to run the service (Docker Compose for the database is fine) and how you verified each rule.
    

## Priority

1. The exact-once claim across two workers (rules 1 and 2).
    
2. Crash recovery and safe retries (rules 4 and 5).
    
3. Everything else. Tell us what you cut and why.
    

  
**