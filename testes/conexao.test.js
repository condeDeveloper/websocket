import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { after, describe, it } from 'node:test';

import { ServidorWebSocket, servir } from '../src/servidor.js';
import { conectar, proximaMensagem } from '../src/cliente.js';
import { FECHAMENTO, OPCODES, montarQuadro } from '../src/quadro.js';

const servidores = [];

/** Sobe um servidor de eco e devolve ele já escutando. */
async function servidorDeEco(opcoes = {}) {
  const servidor = await servir(opcoes);

  servidor.on('conexao', (conexao) => {
    conexao.on('mensagem', ({ dados }) => {
      if (conexao.aberta) conexao.enviar(dados);
    });
  });

  servidores.push(servidor);

  return servidor;
}

/** Espera um evento com prazo, para o teste falhar em vez de pendurar. */
function esperar(emissor, evento, prazo = 5000) {
  return new Promise((cumprir, rejeitar) => {
    const relogio = setTimeout(() => rejeitar(new Error(`Nenhum "${evento}" em ${prazo} ms.`)), prazo);

    emissor.once(evento, (...args) => {
      clearTimeout(relogio);
      cumprir(args.length > 1 ? args : args[0]);
    });
  });
}

after(async () => {
  for (const servidor of servidores) await servidor.fechar();
});

describe('ida e volta', () => {
  it('o texto volta igual', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    conexao.enviar('olá, mundo');

    const { tipo, dados } = await proximaMensagem(conexao);

    assert.equal(tipo, 'texto');
    assert.equal(dados, 'olá, mundo');

    conexao.fechar();
  });

  it('acentos e emoji atravessam intactos', async () => {
    // O tamanho do quadro é em bytes; contar caracteres corromperia isto.
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);
    const original = 'ação, coração, 日本語 e 🙂';

    conexao.enviar(original);

    assert.equal((await proximaMensagem(conexao)).dados, original);

    conexao.fechar();
  });

  it('binário volta como Buffer, não como texto', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);
    const original = Buffer.from([0, 1, 2, 250, 255, 0]);

    conexao.enviar(original);

    const { tipo, dados } = await proximaMensagem(conexao);

    assert.equal(tipo, 'binario');
    assert.deepEqual(dados, original);

    conexao.fechar();
  });

  it('mensagem de 1 MB chega inteira', async () => {
    // Aqui TCP com certeza parte em vários pedaços: é o teste da remontagem.
    const servidor = await servidorDeEco({ maximoDeMensagem: 4 * 1024 * 1024 });
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);
    const original = Buffer.alloc(1024 * 1024, 0xab);

    conexao.enviar(original);

    const { dados } = await proximaMensagem(conexao, { prazo: 15_000 });

    assert.equal(dados.length, original.length);
    assert.ok(dados.equals(original));

    conexao.fechar();
  });

  it('mensagem enviada em pedaços chega como uma só', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    conexao.enviarEmPedacos('abcdefghij', 3);

    assert.equal((await proximaMensagem(conexao)).dados, 'abcdefghij');

    conexao.fechar();
  });

  it('mensagem vazia é uma mensagem', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    conexao.enviar('');

    assert.equal((await proximaMensagem(conexao)).dados, '');

    conexao.fechar();
  });

  it('as mensagens chegam na ordem em que foram enviadas', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);
    const recebidas = [];

    conexao.on('mensagem', ({ dados }) => recebidas.push(dados));

    for (const numero of ['um', 'dois', 'três', 'quatro']) conexao.enviar(numero);

    while (recebidas.length < 4) await esperar(conexao, 'mensagem');

    assert.deepEqual(recebidas, ['um', 'dois', 'três', 'quatro']);

    conexao.fechar();
  });
});

describe('controle', () => {
  it('o ping é respondido com a mesma carga', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    conexao.ping(Buffer.from('marca'));

    assert.equal((await esperar(conexao, 'pong')).toString(), 'marca');

    conexao.fechar();
  });

  it('o ping passa entre os pedaços de uma mensagem grande', async () => {
    // É para isso que quadro de controle não pode ser fragmentado.
    const servidor = await servir();

    servidores.push(servidor);

    servidor.on('conexao', (conexao) => {
      conexao.on('mensagem', () => conexao.enviar('recebi'));
    });

    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    conexao.enviarQuadro({ fin: false, opcode: OPCODES.texto, carga: Buffer.from('parte 1 ') });
    conexao.ping(Buffer.from('no meio'));

    assert.equal((await esperar(conexao, 'pong')).toString(), 'no meio');

    conexao.enviarQuadro({ fin: true, opcode: OPCODES.continuacao, carga: Buffer.from('parte 2') });

    assert.equal((await proximaMensagem(conexao)).dados, 'recebi');

    conexao.fechar();
  });

  it('o fechamento é ecoado e os dois lados sabem o código', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    conexao.fechar(FECHAMENTO.saindo, 'tchau');

    const motivo = await esperar(conexao, 'fechada');

    assert.equal(conexao.estado, 'fechada');
    assert.equal(motivo.codigo, FECHAMENTO.saindo);
  });

  it('enviar depois de fechar reclama em vez de sumir', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    conexao.fechar();

    assert.throws(() => conexao.enviar('tarde demais'), /A conexão está/);
  });

  it('fechar duas vezes não faz nada da segunda', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    assert.equal(conexao.fechar(), true);
    assert.equal(conexao.fechar(), false);
  });
});

describe('o servidor faz a RFC valer', () => {
  it('quadro do cliente sem máscara derruba a conexão', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    // Escrevendo direto no soquete para burlar o mascaramento do cliente.
    conexao.soquete.write(montarQuadro({ opcode: OPCODES.texto, carga: 'sem máscara' }));

    const motivo = await esperar(conexao, 'fechada');

    assert.equal(motivo.codigo, FECHAMENTO.protocolo);
  });

  it('texto com UTF-8 inválido fecha com 1007', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);
    const quebrado = Buffer.from([0xc3, 0x28]);

    conexao.enviarQuadro({ opcode: OPCODES.texto, carga: quebrado });

    const motivo = await esperar(conexao, 'fechada');

    assert.equal(motivo.codigo, FECHAMENTO.dadosInvalidos);
  });

  it('mensagem acima do limite fecha com 1009', async () => {
    const servidor = await servidorDeEco({ maximoDeMensagem: 1024 });
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    conexao.enviar(Buffer.alloc(5000));

    const motivo = await esperar(conexao, 'fechada');

    assert.equal(motivo.codigo, FECHAMENTO.grandeDemais);
  });

  it('mensagem nova antes de a anterior terminar é erro de protocolo', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    conexao.enviarQuadro({ fin: false, opcode: OPCODES.texto, carga: Buffer.from('começo') });
    conexao.enviarQuadro({ fin: true, opcode: OPCODES.texto, carga: Buffer.from('outra') });

    assert.equal((await esperar(conexao, 'fechada')).codigo, FECHAMENTO.protocolo);
  });

  it('continuação sem mensagem começada é erro de protocolo', async () => {
    const servidor = await servidorDeEco();
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    conexao.enviarQuadro({ fin: true, opcode: OPCODES.continuacao, carga: Buffer.from('solta') });

    assert.equal((await esperar(conexao, 'fechada')).codigo, FECHAMENTO.protocolo);
  });
});

describe('aperto de mão pela rede', () => {
  it('recusa quem não pede upgrade, dizendo por quê', async () => {
    const servidor = await servidorDeEco();

    const resposta = await new Promise((cumprir) => {
      const soquete = connect(servidor.porta, '127.0.0.1', () => {
        soquete.write('GET / HTTP/1.1\r\nHost: local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 8\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
      });

      let texto = '';

      soquete.on('data', (d) => {
        texto += d;
      });
      soquete.on('close', () => cumprir(texto));
    });

    assert.match(resposta, /^HTTP\/1\.1 426 /);
    assert.match(resposta, /Sec-WebSocket-Version: 13/);
  });

  it('recusa o caminho errado quando o servidor exige um', async () => {
    const servidor = await servidorDeEco({ caminho: '/sala' });

    await assert.rejects(() => conectar(`ws://127.0.0.1:${servidor.porta}/outra`), /404/);

    const certa = await conectar(`ws://127.0.0.1:${servidor.porta}/sala`);

    certa.enviar('oi');

    assert.equal((await proximaMensagem(certa)).dados, 'oi');

    certa.fechar();
  });

  it('a verificação do servidor pode barrar', async () => {
    const servidor = await servidorDeEco({
      verificar: (requisicao) => requisicao.headers['x-senha'] === 'abre-te',
    });

    await assert.rejects(() => conectar(`ws://127.0.0.1:${servidor.porta}`), /403/);

    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`, { cabecalhos: { 'x-senha': 'abre-te' } });

    assert.equal(conexao.estado, 'aberta');

    conexao.fechar();
  });

  it('o subprotocolo negociado chega nos dois lados', async () => {
    const servidor = await servidorDeEco({ protocolos: ['superchat', 'chat'] });
    const conexao = await conectar(`ws://127.0.0.1:${servidor.porta}`, { protocolos: ['chat', 'superchat'] });

    assert.equal(conexao.protocolo, 'superchat');

    conexao.fechar();
  });

  it('sem subprotocolo em comum não abre', async () => {
    const servidor = await servidorDeEco({ protocolos: ['chat'] });

    await assert.rejects(() => conectar(`ws://127.0.0.1:${servidor.porta}`, { protocolos: ['outro'] }), /400/);
  });

  it('quem não fala WebSocket leva 426 na porta', async () => {
    const servidor = await servidorDeEco();

    const resposta = await fetch(`http://127.0.0.1:${servidor.porta}/`);

    assert.equal(resposta.status, 426);
  });
});

describe('várias conexões', () => {
  it('transmitir alcança todo mundo menos quem mandou', async () => {
    const servidor = new ServidorWebSocket();

    servidores.push(servidor);
    await servidor.escutar();

    servidor.on('conexao', (conexao) => {
      conexao.on('mensagem', ({ dados }) => servidor.transmitir(dados, conexao));
    });

    const um = await conectar(`ws://127.0.0.1:${servidor.porta}`);
    const dois = await conectar(`ws://127.0.0.1:${servidor.porta}`);
    const tres = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    const recebidoPorUm = [];

    um.on('mensagem', ({ dados }) => recebidoPorUm.push(dados));

    um.enviar('de um para os outros');

    assert.equal((await proximaMensagem(dois)).dados, 'de um para os outros');
    assert.equal((await proximaMensagem(tres)).dados, 'de um para os outros');
    assert.deepEqual(recebidoPorUm, []);

    for (const conexao of [um, dois, tres]) conexao.fechar();
  });

  it('o servidor sabe quantas conexões tem e esquece as que caem', async () => {
    const servidor = await servidorDeEco();

    const um = await conectar(`ws://127.0.0.1:${servidor.porta}`);
    const dois = await conectar(`ws://127.0.0.1:${servidor.porta}`);

    while (servidor.conexoes.size < 2) await esperar(servidor, 'conexao');

    assert.equal(servidor.conexoes.size, 2);

    um.fechar();
    dois.fechar();

    const ateSumir = Date.now() + 4000;

    while (servidor.conexoes.size > 0 && Date.now() < ateSumir) {
      await new Promise((cumprir) => setTimeout(cumprir, 50));
    }

    assert.equal(servidor.conexoes.size, 0);
  });
});
