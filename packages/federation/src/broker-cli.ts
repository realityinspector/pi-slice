import { PeerBroker } from './broker.js';

const port = parseInt(process.env.PORT || process.env.SLICE_BROKER_PORT || '7899', 10);
const broker = new PeerBroker(port);

broker.start();

process.on('SIGTERM', () => broker.stop().then(() => process.exit(0)));
process.on('SIGINT', () => broker.stop().then(() => process.exit(0)));
