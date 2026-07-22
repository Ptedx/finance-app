import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import routes from './routes/index.js';

const app = express();
const port = process.env.PORT || 3009;

app.use(cors());
app.use(express.json());

app.use('/api', routes);

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', message: 'Spendr API is running!' });
});

app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
