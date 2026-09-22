import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ErroDeProtocolo,
  FECHAMENTO,
  MAXIMO_DE_CONTROLE,
  OPCODES,
  cargaDeFechamento,
  ehControle,
  lerFechamento,
  lerQuadro,
  mascarar,
  montarQuadro,
} from '../src/quadro.js';

/** Atalho para escrever vetor de bytes legível. */
const bytes = (...valores) => Buffer.from(valores);

describe('vetores da RFC 6455 §5.7', () => {
  // São os exemplos da própria especificação. Se um projeto de WebSocket
  // passa neles, pelo menos o formato está certo.

  it('"Hello" sem máscara, do servidor para o cliente', () => {
    const vetor = bytes(0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f);
    const { quadro, consumido } = lerQuadro(vetor);

    assert.equal(quadro.fin, true);
    assert.equal(quadro.nome, 'texto');
    assert.equal(quadro.mascarado, false);
    assert.equal(quadro.carga.toString('utf8'), 'Hello');
    assert.equal(consumido, vetor.length);

    assert.deepEqual(montarQuadro({ opcode: OPCODES.texto, carga: 'Hello' }), vetor);
  });

  it('"Hello" com máscara, do cliente para o servidor', () => {
    const vetor = bytes(0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58);
    const { quadro } = lerQuadro(vetor);

    assert.equal(quadro.mascarado, true);
    assert.equal(quadro.carga.toString('utf8'), 'Hello');

    const remontado = montarQuadro({
      opcode: OPCODES.texto,
      carga: 'Hello',
      chave: bytes(0x37, 0xfa, 0x21, 0x3d),
    });

    assert.deepEqual(remontado, vetor);
  });

  it('"Hel" + "lo" em dois quadros', () => {
    const primeiro = lerQuadro(bytes(0x01, 0x03, 0x48, 0x65, 0x6c)).quadro;
    const segundo = lerQuadro(bytes(0x80, 0x02, 0x6c, 0x6f)).quadro;

    assert.equal(primeiro.fin, false);
    assert.equal(primeiro.nome, 'texto');
    assert.equal(segundo.fin, true);
    assert.equal(segundo.nome, 'continuacao');
    assert.equal(Buffer.concat([primeiro.carga, segundo.carga]).toString('utf8'), 'Hello');
  });

  it('ping e pong com "Hello"', () => {
    assert.equal(lerQuadro(bytes(0x89, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f)).quadro.nome, 'ping');
    assert.equal(lerQuadro(bytes(0x8a, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f)).quadro.nome, 'pong');
  });

  it('256 bytes binários usam o tamanho de 16 bits', () => {
    const carga = Buffer.alloc(256, 7);
    const montado = montarQuadro({ opcode: OPCODES.binario, carga });

    assert.deepEqual(montado.subarray(0, 4), bytes(0x82, 0x7e, 0x01, 0x00));
    assert.deepEqual(lerQuadro(montado).quadro.carga, carga);
  });

  it('64 KiB binários usam o tamanho de 64 bits', () => {
    const carga = Buffer.alloc(65_536, 7);
    const montado = montarQuadro({ opcode: OPCODES.binario, carga });

    assert.deepEqual(montado.subarray(0, 10), bytes(0x82, 0x7f, 0, 0, 0, 0, 0, 1, 0, 0));
    assert.equal(lerQuadro(montado).quadro.carga.length, 65_536);
  });

  it('a fronteira dos 125 bytes muda o formato do cabeçalho', () => {
    // 125 ainda cabe no byte; 126 já obriga o tamanho estendido.
    assert.equal(montarQuadro({ carga: Buffer.alloc(125) }).length, 2 + 125);
    assert.equal(montarQuadro({ carga: Buffer.alloc(126) }).length, 4 + 126);
    assert.equal(montarQuadro({ carga: Buffer.alloc(65_535) }).length, 4 + 65_535);
    assert.equal(montarQuadro({ carga: Buffer.alloc(65_536) }).length, 10 + 65_536);
  });
});

describe('máscara', () => {
  it('é o seu próprio inverso', () => {
    const chave = bytes(0x37, 0xfa, 0x21, 0x3d);
    const original = Buffer.from('um texto qualquer com acento: ação');

    assert.deepEqual(mascarar(mascarar(original, chave), chave), original);
  });

  it('carga vazia atravessa sem drama', () => {
    assert.equal(mascarar(Buffer.alloc(0), bytes(1, 2, 3, 4)).length, 0);
  });
});

describe('leitura parcial', () => {
  it('quadro incompleto devolve null em vez de inventar', () => {
    // O caso normal em TCP: o `data` trouxe metade do cabeçalho.
    const inteiro = montarQuadro({ opcode: OPCODES.texto, carga: 'mensagem comprida o bastante' });

    for (let corte = 0; corte < inteiro.length; corte += 1) {
      assert.equal(lerQuadro(inteiro.subarray(0, corte)), null, `deveria faltar byte em ${corte}`);
    }

    assert.notEqual(lerQuadro(inteiro), null);
  });

  it('tamanho estendido pela metade também devolve null', () => {
    const grande = montarQuadro({ carga: Buffer.alloc(300) });

    assert.equal(lerQuadro(grande.subarray(0, 3)), null);
  });

  it('máscara pela metade também devolve null', () => {
    const comMascara = montarQuadro({ carga: 'oi', chave: bytes(1, 2, 3, 4) });

    assert.equal(lerQuadro(comMascara.subarray(0, 4)), null);
  });

  it('`consumido` permite ler dois quadros grudados', () => {
    const juntos = Buffer.concat([
      montarQuadro({ opcode: OPCODES.texto, carga: 'um' }),
      montarQuadro({ opcode: OPCODES.texto, carga: 'dois' }),
    ]);

    const primeiro = lerQuadro(juntos);
    const segundo = lerQuadro(juntos.subarray(primeiro.consumido));

    assert.equal(primeiro.quadro.carga.toString(), 'um');
    assert.equal(segundo.quadro.carga.toString(), 'dois');
  });
});

describe('o que a RFC proíbe', () => {
  it('bits RSV ligados sem extensão', () => {
    assert.throws(() => lerQuadro(bytes(0xc1, 0x00)), ErroDeProtocolo);
  });

  it('opcode que não existe', () => {
    assert.throws(() => lerQuadro(bytes(0x83, 0x00)), /Opcode desconhecido/);
  });

  it('quadro de controle com mais de 125 bytes', () => {
    // Ele precisa caber num pedaço só para poder ser respondido no meio de
    // uma mensagem grande.
    assert.throws(() => lerQuadro(Buffer.concat([bytes(0x89, 0x7e, 0x00, 0xc8), Buffer.alloc(200)])), /limite é 125/);
    assert.throws(() => montarQuadro({ opcode: OPCODES.ping, carga: Buffer.alloc(126) }), /limite é 125/);
  });

  it('quadro de controle fragmentado', () => {
    assert.throws(() => lerQuadro(bytes(0x09, 0x00)), /controle fragmentado/);
    assert.throws(() => montarQuadro({ fin: false, opcode: OPCODES.ping }), /não pode ser fragmentado/);
  });

  it('quadro maior que o limite configurado', () => {
    const grande = montarQuadro({ carga: Buffer.alloc(300) });

    assert.throws(() => lerQuadro(grande, { maximo: 100 }), /passa do limite/);
  });

  it('controle no limite exato dos 125 passa', () => {
    const noLimite = montarQuadro({ opcode: OPCODES.ping, carga: Buffer.alloc(MAXIMO_DE_CONTROLE) });

    assert.equal(lerQuadro(noLimite).quadro.carga.length, MAXIMO_DE_CONTROLE);
  });

  it('reconhece quais opcodes são de controle', () => {
    assert.equal(ehControle(OPCODES.ping), true);
    assert.equal(ehControle(OPCODES.fechar), true);
    assert.equal(ehControle(OPCODES.texto), false);
    assert.equal(ehControle(OPCODES.continuacao), false);
  });
});

describe('fechamento', () => {
  it('código e motivo vão e voltam', () => {
    const lido = lerFechamento(cargaDeFechamento(FECHAMENTO.politica, 'excedeu a cota'));

    assert.equal(lido.codigo, FECHAMENTO.politica);
    assert.equal(lido.motivo, 'excedeu a cota');
  });

  it('fechar sem dizer nada é permitido', () => {
    assert.deepEqual(lerFechamento(Buffer.alloc(0)), { codigo: FECHAMENTO.semCodigo, motivo: '' });
  });

  it('um byte só não forma um código', () => {
    assert.throws(() => lerFechamento(bytes(0x03)), ErroDeProtocolo);
  });

  it('1005 e 1006 são locais e não podem vir pela rede', () => {
    // Existem para a aplicação descrever o que houve; recebê-los significa
    // que o outro lado está inventando.
    assert.throws(() => lerFechamento(cargaDeFechamento(1005)), /inválido/);
    assert.throws(() => lerFechamento(cargaDeFechamento(1006)), /inválido/);
    assert.throws(() => lerFechamento(cargaDeFechamento(999)), /inválido/);
    assert.throws(() => lerFechamento(cargaDeFechamento(2000)), /inválido/);
  });

  it('a faixa 3000+ é livre para a aplicação', () => {
    assert.equal(lerFechamento(cargaDeFechamento(3001, 'meu motivo')).codigo, 3001);
    assert.equal(lerFechamento(cargaDeFechamento(4999)).codigo, 4999);
  });

  it('motivo grande demais não cabe num quadro de controle', () => {
    assert.throws(() => cargaDeFechamento(1000, 'x'.repeat(130)), /não cabe/);
  });
});
