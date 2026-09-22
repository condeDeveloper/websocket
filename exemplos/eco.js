/**
 * Uma sala de bate-papo em 40 linhas.
 *
 *   node exemplos/eco.js
 *
 * Depois, no console do navegador (ou em outra aba):
 *
 *   const ws = new WebSocket('ws://127.0.0.1:8080/sala');
 *   ws.onmessage = (e) => console.log(e.data);
 *   ws.send('oi');
 */

import { ServidorWebSocket } from '../src/servidor.js';

const servidor = new ServidorWebSocket({
  caminho: '/sala',
  // Ping a cada 30 s: sem isso, uma conexão cortada por NAT fica "aberta"
  // dos dois lados até alguém tentar escrever.
  batimento: 30_000,
});

let proximo = 1;

servidor.on('conexao', (conexao, requisicao) => {
  const nome = `visitante-${proximo++}`;

  console.log(`+ ${nome} entrou de ${requisicao.socket.remoteAddress}`);

  conexao.enviar(`Bem-vindo. Você é ${nome}. Há ${servidor.conexoes.size} pessoa(s) aqui.`);
  servidor.transmitir(`${nome} entrou.`, conexao);

  conexao.on('mensagem', ({ tipo, dados }) => {
    if (tipo !== 'texto') return;

    servidor.transmitir(`${nome}: ${dados}`, conexao);
  });

  conexao.on('fechada', ({ codigo }) => {
    console.log(`- ${nome} saiu (${codigo})`);
    servidor.transmitir(`${nome} saiu.`);
  });
});

servidor.on('recusa', (erro) => console.log(`recusado: ${erro.message}`));

await servidor.escutar(8080, '127.0.0.1');

console.log(`Sala aberta em ws://127.0.0.1:${servidor.porta}/sala`);
