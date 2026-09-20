import app from './app.js';

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`WST API listening on ${port} — docs at http://localhost:${port}/docs`));
