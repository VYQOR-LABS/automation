# automation
curl -i -X POST `
     https://graph.facebook.com/v25.0/1405128762692212/messages `
     -H 'Authorization: Bearer EAAUhpGCE4UABS8XGkY1kKUg25VctMIptY0OO1gw1SeTtkVL9zne8Ppxw30ZBvwim3EfAcMywluxo4yL7oS1vbHaZBZAT9YQqBhUU38FEjtt7zoQ79TNH0B9scBl95b8e32hGZCofTCQ1Ngz0UJpDRq92OKN6lUQQegdW0yIYYgq38eCJwoScH7qFLjZAlzQmwNjShdox2VneeBCk4nI7s08JGEMDyZATv5YW9Oh3YD3KqZCf3LZCmGpq9YA1NayeHydSZAzXox2wY9ZCarxV5KeiSrXPRNcQZDZD' `
     -H 'Content-Type: application/json' `
     -d '{ \"messaging_product\": \"whatsapp\",
     \"to\": \"254791614036\",
     \"type\": \"template\",
     \"template\": { \"name\": \"jaspers_market_order_confirmation_v1\",
     \"language\": { \"code\": \"en_US\" },
     \"components\": [{ \"type\": \"body\", \"parameters\": [{ \"type\": \"text\", \"text\": \"John Doe\" }, { \"type\": \"text\", \"text\": \"123456\" }, { \"type\": \"text\", \"text\": \"Nov 14, 2026\" }] }] } }'