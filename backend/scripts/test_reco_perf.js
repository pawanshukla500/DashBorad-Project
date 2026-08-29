import http from 'http';

const start = Date.now();
http.get('http://localhost:3001/api/rate-card/reconcile?marketplace=flipkart', res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('Time taken:', Date.now() - start, 'ms');
    try {
      console.log(JSON.parse(d).summary);
    } catch (e) {
      console.log("Error parsing JSON. Raw output:", d.substring(0, 500));
    }
  });
}).on('error', e => console.error(e));
